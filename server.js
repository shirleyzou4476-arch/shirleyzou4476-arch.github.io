import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const {Pool}=pg;
const root=fileURLToPath(new URL('.',import.meta.url));
export const MAX_SORTING_LOCATIONS=50;
export const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined}):null;
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const body=async req=>{let raw='';for await(const chunk of req)raw+=chunk;try{return raw?JSON.parse(raw):{}}catch{return null}};
const requireDb=res=>{if(!pool){json(res,503,{error:'DATABASE_URL is required for this API'});return false}return true};
const warehouseDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:process.env.WAREHOUSE_TIME_ZONE||'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const query=(sql,params)=>pool.query(sql,params);

async function openCycle(client,date,user='system'){
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`dockflow:${date}`]);
  await client.query(`UPDATE daily_cycles SET status='closed',closed_at=COALESCE(closed_at,now()) WHERE status='open' AND warehouse_date<>$1`,[date]);
  const current=await client.query(`SELECT * FROM daily_cycles WHERE warehouse_date=$1 AND status='open' ORDER BY cycle_number DESC LIMIT 1 FOR UPDATE`,[date]);
  if(current.rows[0])return current.rows[0];
  const prior=await client.query('SELECT COALESCE(MAX(cycle_number),0)::int AS n FROM daily_cycles WHERE warehouse_date=$1',[date]);
  return (await client.query(`INSERT INTO daily_cycles(warehouse_date,cycle_number,status) VALUES($1,$2,'open') RETURNING *`,[date,prior.rows[0].n+1])).rows[0];
}
async function closeCycle(client,cycle){await client.query(`UPDATE daily_cycles SET status='closed',closed_at=now() WHERE id=$1`,[cycle.id])}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const path=url.pathname;
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':url.origin,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'});return res.end()}
  if(path==='/api/health'){if(!pool)return json(res,200,{ok:true,service:'dockflow',database:'not configured'});try{await query('SELECT 1');return json(res,200,{ok:true,service:'dockflow',database:'connected'})}catch{return json(res,503,{ok:false,service:'dockflow',database:'unavailable'})}}
  if(path.startsWith('/api/')&&!requireDb(res))return;
  try{
    if(path==='/api/day'&&req.method==='GET'){
      const date=warehouseDate();const client=await pool.connect();try{const cycle=await openCycle(client,date);const {rows}=await client.query(`SELECT dc.warehouse_date AS "warehouseDate",dc.cycle_number AS "cycleNumber",COUNT(da.id)::int AS assignments FROM daily_cycles dc LEFT JOIN daily_assignments da ON da.cycle_id=dc.id WHERE dc.id=$1 GROUP BY dc.id`,[cycle.id]);return json(res,200,rows[0])}finally{client.release()}
    }
    if(path==='/api/day/reset'&&req.method==='POST'){
      const date=warehouseDate();const input=await body(req)||{};const client=await pool.connect();try{await client.query('BEGIN');const current=await client.query(`SELECT * FROM daily_cycles WHERE warehouse_date=$1 AND status='open' ORDER BY cycle_number DESC LIMIT 1 FOR UPDATE`,[date]);if(current.rows[0])await closeCycle(client,current.rows[0]);const cycle=await openCycle(client,date,input.userId||'supervisor');await client.query('COMMIT');return json(res,201,{warehouseDate:date,cycleNumber:cycle.cycle_number,assignments:0})}catch(err){await client.query('ROLLBACK');throw err}finally{client.release()}
    }
    if(path==='/api/boxes'&&req.method==='GET'){const {rows}=await query(`SELECT b.box_id AS "boxId",b.sku,b.quantity AS qty,p.name,b.status,b.received_at AS "receivedAt" FROM boxes b JOIN products p USING(sku) ORDER BY b.box_id`);return json(res,200,rows)}
    const boxMatch=path.match(/^\/api\/boxes\/([^/]+)$/);if(boxMatch&&req.method==='GET'){const {rows}=await query(`SELECT b.box_id AS "boxId",b.sku,b.quantity AS qty,p.name,b.status,b.received_at AS "receivedAt" FROM boxes b JOIN products p USING(sku) WHERE b.box_id=$1`,[boxMatch[1].toUpperCase()]);return rows[0]?json(res,200,rows[0]):json(res,404,{error:'Box not found'})}
    if(path==='/api/locations'&&req.method==='GET'){
      const date=warehouseDate();const {rows}=await query(`SELECT sl.location_number AS location,sl.capacity,da.sku,COALESCE(SUM(s.qty),0)::int AS filled FROM sorting_locations sl LEFT JOIN daily_cycles dc ON dc.warehouse_date=$1 AND dc.status='open' LEFT JOIN daily_assignments da ON da.cycle_id=dc.id AND da.location_number=sl.location_number LEFT JOIN scan_events s ON s.cycle_id=dc.id AND s.location_number=sl.location_number GROUP BY sl.location_number,sl.capacity,da.sku ORDER BY sl.location_number`,[date]);return json(res,200,rows)
    }
    if(path==='/api/assignments'&&req.method==='GET'){
      const date=warehouseDate();const {rows}=await query(`SELECT da.location_number AS location,da.sku,da.capacity,COALESCE(SUM(s.qty),0)::int AS filled,da.assigned_at AS "assignedAt" FROM daily_assignments da JOIN daily_cycles dc ON dc.id=da.cycle_id LEFT JOIN scan_events s ON s.cycle_id=da.cycle_id AND s.location_number=da.location_number WHERE dc.warehouse_date=$1 AND dc.status='open' GROUP BY da.id ORDER BY da.location_number`,[date]);return json(res,200,rows)
    }
    if(path==='/api/history'&&req.method==='GET'){const q=(url.searchParams.get('q')||'').trim();const {rows}=await query(`SELECT s.box_id AS "boxId",s.sku,s.qty,s.location_number AS loc,s.warehouse_date AS "warehouseDate",s.user_id AS "userId",s.device_id AS "deviceId",s.scanned_at AS "scannedAt",p.name FROM scan_events s JOIN products p USING(sku) WHERE ($1='' OR s.box_id ILIKE '%'||$1||'%' OR s.sku ILIKE '%'||$1||'%') ORDER BY s.scanned_at DESC LIMIT 200`,[q]);return json(res,200,rows)}
    if(path==='/api/exceptions'&&req.method==='GET'){const {rows}=await query(`SELECT id,box_id AS box,reason,status,resolved_at AS "resolvedAt" FROM exceptions ORDER BY (status='open') DESC,created_at DESC`);return json(res,200,rows)}
    const exceptionMatch=path.match(/^\/api\/exceptions\/([^/]+)\/resolve$/);if(exceptionMatch&&req.method==='POST'){const {rows}=await query(`UPDATE exceptions SET status='resolved',resolved_at=now() WHERE id=$1 RETURNING id,box_id AS box,reason,status,resolved_at AS "resolvedAt"`,[exceptionMatch[1]]);return rows[0]?json(res,200,rows[0]):json(res,404,{error:'Exception not found'})}
    if(path==='/api/scans'&&req.method==='POST'){
      const input=await body(req);if(!input)return json(res,400,{error:'Invalid JSON'});const boxId=String(input.boxId||'').trim().toUpperCase();if(!boxId)return json(res,400,{error:'boxId is required'});
      const client=await pool.connect();try{
        await client.query('BEGIN');const found=await client.query('SELECT b.*,p.name FROM boxes b JOIN products p USING(sku) WHERE b.box_id=$1 FOR UPDATE',[boxId]);let box=found.rows[0];
        if(!box){if(!input.sku||!Number.isInteger(input.qty)||input.qty<1){await client.query('ROLLBACK');return json(res,400,{error:'Unknown box; sku and positive integer qty are required'})}box=(await client.query(`INSERT INTO boxes(box_id,sku,quantity,status) VALUES($1,$2,$3,'pending') RETURNING *`,[boxId,String(input.sku).trim().toUpperCase(),input.qty])).rows[0]}
        const existing=await client.query(`SELECT box_id AS "boxId",sku,qty,location_number AS destination,scanned_at AS "scannedAt" FROM scan_events WHERE box_id=$1`,[boxId]);if(existing.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'Duplicate scan',previous:existing.rows[0]})}
        const date=warehouseDate();const cycle=await openCycle(client,date,input.userId||'system');
        const skuAssignments=(await client.query(`SELECT da.* FROM daily_assignments da WHERE da.cycle_id=$1 AND da.sku=$2 ORDER BY da.location_number FOR UPDATE`,[cycle.id,box.sku])).rows;
        let assignment=null;
        for(const candidate of skuAssignments){const filled=Number((await client.query(`SELECT COALESCE(SUM(qty),0)::int AS filled FROM scan_events WHERE cycle_id=$1 AND location_number=$2`,[cycle.id,candidate.location_number])).rows[0].filled);if(filled+box.quantity<=candidate.capacity){assignment=candidate;break}}
        if(!assignment){
          const next=(await client.query(`SELECT sl.* FROM sorting_locations sl WHERE NOT EXISTS (SELECT 1 FROM daily_assignments da WHERE da.cycle_id=$1 AND da.location_number=sl.location_number) ORDER BY sl.location_number LIMIT 1 FOR UPDATE`,[cycle.id])).rows[0];
          if(!next){await client.query(`INSERT INTO exceptions(box_id,reason) VALUES($1,$2)`,[boxId,'NO AVAILABLE SORTING LOCATION']);await client.query('COMMIT');return json(res,409,{error:'NO AVAILABLE SORTING LOCATION',exception:true})}
          assignment=(await client.query(`INSERT INTO daily_assignments(cycle_id,warehouse_date,sku,location_number,capacity,assigned_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[cycle.id,date,box.sku,next.location_number,next.capacity,input.userId||'system'])).rows[0];
        }
        const event=(await client.query(`INSERT INTO scan_events(box_id,sku,qty,destination,location_number,warehouse_date,cycle_id,user_id,device_id,inbound_id,client_id,box_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING box_id AS "boxId",sku,qty,location_number AS destination,warehouse_date AS "warehouseDate",scanned_at AS "scannedAt",user_id AS "userId",device_id AS "deviceId"`,[boxId,box.sku,box.quantity,`LOCATION ${assignment.location_number}`,assignment.location_number,date,cycle.id,input.userId||'unknown',input.deviceId||'unknown',input.inboundId||null,input.clientId||null,input.boxSequence||null])).rows[0];
        await client.query(`UPDATE boxes SET status='received',received_at=COALESCE(received_at,now()) WHERE box_id=$1`,[boxId]);await client.query('COMMIT');return json(res,201,event);
      }catch(err){await client.query('ROLLBACK');if(err.code==='23505')return json(res,409,{error:'Duplicate scan'});if(err.code==='23503')return json(res,400,{error:'SKU does not exist'});throw err}finally{client.release()}
    }
    if(path.startsWith('/api/'))return json(res,404,{error:'Not found'});
    const relative=path==='/'?'index.html':path.slice(1);const file=normalize(join(root,relative));if(!file.startsWith(root))return json(res,404,{error:'Not found'});const data=await readFile(file);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.jsx':'text/javascript; charset=utf-8','.css':'text/css'};res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});res.end(data);
  }catch(err){console.error(err);json(res,500,{error:'Internal server error'})}
});
if(process.argv[1]===fileURLToPath(import.meta.url)){if(!process.env.DATABASE_URL)console.error('DATABASE_URL is not set; API requests will return 503');server.listen(Number(process.env.PORT)||3000,()=>console.log(`DockFlow running on port ${process.env.PORT||3000}`))}
export {server,warehouseDate};
