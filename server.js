import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const {Pool}=pg;
const root=fileURLToPath(new URL('.',import.meta.url));
export const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined}):null;
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const body=async req=>{let raw='';for await(const chunk of req)raw+=chunk;try{return raw?JSON.parse(raw):{}}catch{return null}};
const requireDb=(res)=>{if(!pool){json(res,503,{error:'DATABASE_URL is required for this API'});return false}return true};
const query=sql=>pool.query(sql);
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'); const path=url.pathname;
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':url.origin,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'});return res.end()}
  if(path==='/api/health'){if(!pool)return json(res,200,{ok:true,service:'dockflow',database:'not configured'});try{await query('SELECT 1');return json(res,200,{ok:true,service:'dockflow',database:'connected'})}catch{return json(res,503,{ok:false,service:'dockflow',database:'unavailable'})}}
  if(path.startsWith('/api/')&&!requireDb(res))return;
  try {
    if(path==='/api/boxes'&&req.method==='GET'){const {rows}=await query(`SELECT b.box_id AS "boxId",b.sku,b.quantity AS qty,p.name,b.status,b.received_at AS "receivedAt" FROM boxes b JOIN products p USING(sku) ORDER BY b.box_id`);return json(res,200,rows)}
    const boxMatch=path.match(/^\/api\/boxes\/([^/]+)$/); if(boxMatch&&req.method==='GET'){const {rows}=await pool.query(`SELECT b.box_id AS "boxId",b.sku,b.quantity AS qty,p.name,b.status,b.received_at AS "receivedAt" FROM boxes b JOIN products p USING(sku) WHERE b.box_id=$1`,[boxMatch[1].toUpperCase()]);return rows[0]?json(res,200,rows[0]):json(res,404,{error:'Box not found'})}
    if(path==='/api/locations'&&req.method==='GET'){const {rows}=await query(`SELECT r.sku,r.location_code AS location,r.capacity,COALESCE(SUM(s.qty) FILTER (WHERE s.destination=r.location_code),0)::int AS filled FROM routing_rules r LEFT JOIN scan_events s ON s.destination=r.location_code GROUP BY r.id ORDER BY r.sku,r.priority`);return json(res,200,rows)}
    if(path==='/api/history'&&req.method==='GET'){const q=(url.searchParams.get('q')||'').trim();const {rows}=await pool.query(`SELECT s.box_id AS "boxId",s.sku,s.qty,s.destination AS loc,s.user_id AS "userId",s.device_id AS "deviceId",s.scanned_at AS "scannedAt",p.name FROM scan_events s JOIN products p USING(sku) WHERE ($1='' OR s.box_id ILIKE '%'||$1||'%' OR s.sku ILIKE '%'||$1||'%') ORDER BY s.scanned_at DESC LIMIT 200`,[q]);return json(res,200,rows)}
    if(path==='/api/exceptions'&&req.method==='GET'){const {rows}=await query(`SELECT id,box_id AS box,reason,status,resolved_at AS "resolvedAt" FROM exceptions ORDER BY (status='open') DESC, created_at DESC`);return json(res,200,rows)}
    const exceptionMatch=path.match(/^\/api\/exceptions\/([^/]+)\/resolve$/);if(exceptionMatch&&req.method==='POST'){const {rows}=await pool.query(`UPDATE exceptions SET status='resolved',resolved_at=now() WHERE id=$1 RETURNING id,box_id AS box,reason,status,resolved_at AS "resolvedAt"`,[exceptionMatch[1]]);return rows[0]?json(res,200,rows[0]):json(res,404,{error:'Exception not found'})}
    if(path==='/api/scans'&&req.method==='POST'){
      const input=await body(req);if(!input)return json(res,400,{error:'Invalid JSON'});const boxId=String(input.boxId||'').trim().toUpperCase();if(!boxId)return json(res,400,{error:'boxId is required'});
      const client=await pool.connect();try{await client.query('BEGIN');const found=await client.query('SELECT b.*,p.name FROM boxes b JOIN products p USING(sku) WHERE b.box_id=$1 FOR UPDATE',[boxId]);let box=found.rows[0];if(!box){if(!input.sku||!Number.isInteger(input.qty)||input.qty<1) {await client.query('ROLLBACK');return json(res,400,{error:'Unknown box; sku and positive integer qty are required'})}const inserted=await client.query(`INSERT INTO boxes(box_id,sku,quantity,status) VALUES($1,$2,$3,'pending') RETURNING *`,[boxId,String(input.sku).toUpperCase(),input.qty]);box=inserted.rows[0]}
        const existing=await client.query(`SELECT box_id AS "boxId",sku,qty,destination,scanned_at AS "scannedAt" FROM scan_events WHERE box_id=$1`,[boxId]);if(existing.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'Duplicate scan',previous:existing.rows[0]})}
        const destination=(await client.query(`SELECT r.location_code FROM routing_rules r WHERE r.sku=$1 AND r.active=true ORDER BY r.priority LIMIT 1`,[box.sku])).rows[0]?.location_code||'OVERFLOW';
        const event=(await client.query(`INSERT INTO scan_events(box_id,sku,qty,destination,user_id,device_id,inbound_id,client_id,box_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING box_id AS "boxId",sku,qty,destination,scanned_at AS "scannedAt",user_id AS "userId",device_id AS "deviceId"`,[boxId,box.sku,box.quantity,destination,input.userId||'unknown',input.deviceId||'unknown',input.inboundId||null,input.clientId||null,input.boxSequence||null])).rows[0];await client.query(`UPDATE boxes SET status='received',received_at=COALESCE(received_at,now()) WHERE box_id=$1`,[boxId]);await client.query('COMMIT');return json(res,201,event);
      }catch(err){await client.query('ROLLBACK');if(err.code==='23505')return json(res,409,{error:'Duplicate scan'});if(err.code==='23503')return json(res,400,{error:'SKU does not exist'});throw err}finally{client.release()}
    }
    if(path.startsWith('/api/'))return json(res,404,{error:'Not found'});
    const relative=path==='/'?'index.html':path.slice(1);const file=normalize(join(root,relative));if(!file.startsWith(root))return json(res,404,{error:'Not found'});const data=await readFile(file);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.jsx':'text/javascript; charset=utf-8','.css':'text/css'};res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});res.end(data);
  } catch(err){console.error(err);json(res,500,{error:'Internal server error'})}
});
if(process.argv[1]===fileURLToPath(import.meta.url)) {if(!process.env.DATABASE_URL)console.error('DATABASE_URL is not set; API requests will return 503');server.listen(Number(process.env.PORT)||3000,()=>console.log(`DockFlow running on port ${process.env.PORT||3000}`))}
export {server};
