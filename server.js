import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';

const {Pool}=pg;
const root=fileURLToPath(new URL('.',import.meta.url));
export const MAX_SORTING_LOCATIONS=50;
export const WAREHOUSE_TIME_ZONE='America/Chicago';
export const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined}):null;
const SESSION_DAYS=7;
const BOOTSTRAP_WINDOW_MS=15*60*1000;
const bootstrapAttempts=new Map();
if(pool){const cleanup=setInterval(()=>pool.query('DELETE FROM sessions WHERE expires_at<=now()').catch(()=>{}),60*60*1000);cleanup.unref?.()}
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const cookieName='dockflow_session';
const parseCookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i).trim(),decodeURIComponent(v.slice(i+1))]}));
const setCookie=(res,value,maxAge=SESSION_DAYS*86400)=>res.setHeader('set-cookie',`${cookieName}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${process.env.NODE_ENV==='production'?'; Secure':''}`);
const clearCookie=res=>setCookie(res,'',0);
const tokenHash=token=>createHash('sha256').update(token).digest('hex');
const sameToken=(provided,configured)=>{
  const providedHash=Buffer.from(tokenHash(provided),'hex');
  const configuredHash=Buffer.from(tokenHash(configured),'hex');
  return timingSafeEqual(providedHash,configuredHash);
};
const requestIsHttps=req=>req.socket.encrypted===true||String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';
const clientAddress=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
const bootstrapAllowed=(req)=>{
  const now=Date.now();const key=clientAddress(req);const previous=bootstrapAttempts.get(key);
  if(!previous||now-previous.startedAt>=BOOTSTRAP_WINDOW_MS){bootstrapAttempts.set(key,{startedAt:now,count:1});return true}
  previous.count+=1;return previous.count<=5;
};
const bootstrapError=res=>json(res,403,{error:'Setup unavailable'});
async function sessionUser(req,res){
  if(!pool)return null;
  const token=parseCookies(req)[cookieName];if(!token)return null;
  const {rows}=await pool.query(`SELECT u.id,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,[tokenHash(token)]);
  if(rows[0]){pool.query('UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1',[tokenHash(token)]).catch(()=>{});return rows[0]}
  return null;
}
const roleRank={worker:1,manager:2,admin:3};
const routeRole=(method,path)=>{
  if(path==='/api/auth/me'||path==='/api/auth/logout')return 'worker';
  if(path==='/api/users'||path.startsWith('/api/users/'))return 'admin';
  if(path==='/api/day/reset')return 'admin';
  if(method==='GET'&&(/^\/api\/archive/.test(path)||path==='/api/history'))return 'manager';
  if(path==='/api/health')return null;
  if(path.startsWith('/api/'))return 'worker';
  return null;
};
const sameOrigin=(req)=>{
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return true;
  const source=req.headers.origin||req.headers.referer;
  if(!source)return true;
  try{return new URL(source).host===req.headers.host}catch{return false}
};
async function requireAuth(req,res,minimum){
  const user=await sessionUser(req,res);
  if(!user){json(res,401,{error:'Authentication required'});return null}
  if(minimum&&roleRank[user.role]<roleRank[minimum]){json(res,403,{error:'Insufficient permissions'});return null}
  return user;
}
const body=async req=>{let raw='';for await(const chunk of req)raw+=chunk;try{return raw?JSON.parse(raw):{}}catch{return null}};
const requireDb=res=>{if(!pool){json(res,503,{error:'DATABASE_URL is required for this API'});return false}return true};
const warehouseDateAt=date=>{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:WAREHOUSE_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const values=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const warehouseDate=()=>warehouseDateAt(new Date());
const query=(sql,params)=>pool.query(sql,params);
const csvCell=value=>`"${String(value??'').replaceAll('"','""')}"`;
const archiveDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?value:null;
const archiveFilters=(params,startIndex=1)=>{
  const values=[];const clauses=[];
  const add=(column,value)=>{if(value){values.push(value);clauses.push(`${column} ILIKE '%'||$${startIndex+values.length-1}||'%'`)}};
  add('s.sku',params.get('sku'));add('s.box_id',params.get('boxId'));add('s.inbound_id',params.get('inbound'));add('s.client_id',params.get('client'));add('s.location_number::text',params.get('location'));add('s.user_id',params.get('user'));add('s.device_id',params.get('device'));
  return {clauses,values};
};

async function openCycle(client,date,user='system',mode='auto',startedAt=new Date()){
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`dockflow:${date}`]);
  await client.query(`UPDATE daily_cycles SET status='closed',closed_at=COALESCE(closed_at,now()) WHERE status='open' AND warehouse_date<>$1`,[date]);
  const current=await client.query(`SELECT * FROM daily_cycles WHERE warehouse_date=$1 AND status='open' ORDER BY cycle_number DESC LIMIT 1 FOR UPDATE`,[date]);
  if(current.rows[0])return current.rows[0];
  const prior=await client.query('SELECT COALESCE(MAX(cycle_number),0)::int AS n FROM daily_cycles WHERE warehouse_date=$1',[date]);
  return (await client.query(`INSERT INTO daily_cycles(warehouse_date,cycle_number,status,started_by,start_mode,started_at) VALUES($1,$2,'open',$3,$4,$5) RETURNING *`,[date,prior.rows[0].n+1,user,mode,startedAt])).rows[0];
}
async function closeCycle(client,cycle){await client.query(`UPDATE daily_cycles SET status='closed',closed_at=now() WHERE id=$1`,[cycle.id])}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const path=url.pathname;
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':url.origin,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'});return res.end()}
  if(path==='/api/health'){if(!pool)return json(res,200,{ok:true,service:'dockflow',database:'not configured'});try{await query('SELECT 1');return json(res,200,{ok:true,service:'dockflow',database:'connected'})}catch{return json(res,503,{ok:false,service:'dockflow',database:'unavailable'})}}
  if(path==='/api/auth/bootstrap'&&req.method==='POST'){
    if(!pool)return bootstrapError(res);
    if(process.env.NODE_ENV==='production'&&!requestIsHttps(req))return bootstrapError(res);
    if(!bootstrapAllowed(req))return json(res,429,{error:'Setup unavailable'});
    const configuredToken=process.env.DOCKFLOW_SETUP_TOKEN;
    const providedToken=String(req.headers['x-dockflow-setup-token']||'');
    if(!configuredToken||configuredToken.length<32||!providedToken||!sameToken(providedToken,configuredToken))return bootstrapError(res);
    if(!sameOrigin(req))return bootstrapError(res);
    const input=await body(req);const email=String(input?.email||'').trim().toLowerCase();const passcode=String(input?.password||'');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||passcode.length<12)return bootstrapError(res);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['dockflow:admin-bootstrap']);
      const state=(await client.query('SELECT consumed_at FROM admin_bootstrap WHERE id=true FOR UPDATE')).rows[0];
      const activeAdmin=(await client.query(`SELECT 1 FROM users WHERE role='admin' AND active LIMIT 1`)).rows[0];
      if(!state||state.consumed_at||activeAdmin){await client.query('ROLLBACK');return bootstrapError(res)}
      const hash=await bcrypt.hash(passcode,12);
      const created=(await client.query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') RETURNING id`,[email,hash])).rows[0];
      await client.query('UPDATE admin_bootstrap SET consumed_at=now(),consumed_by=$1 WHERE id=true',[created.id]);
      await client.query('COMMIT');
      bootstrapAttempts.delete(clientAddress(req));
      return json(res,201,{ok:true});
    }catch(err){await client.query('ROLLBACK');if(err.code==='23505')return bootstrapError(res);throw err}finally{client.release()}
  }
  if(path.startsWith('/api/')&&!requireDb(res))return;
  try{
    if(path==='/api/auth/login'&&req.method==='POST'){
      if(!sameOrigin(req))return json(res,403,{error:'Cross-origin request blocked'});
      const input=await body(req);const email=String(input?.email||'').trim().toLowerCase();const passcode=String(input?.password||'');
      const found=await query('SELECT * FROM users WHERE email=$1 AND active',[email]);
      if(!found.rows[0]||!(await bcrypt.compare(passcode,found.rows[0].password_hash)))return json(res,401,{error:'Invalid email or password'});
      await query('DELETE FROM sessions WHERE expires_at<=now()');
      const token=randomBytes(32).toString('base64url');const expires=new Date(Date.now()+SESSION_DAYS*86400000);
      await query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[found.rows[0].id,tokenHash(token),expires]);setCookie(res,token);
      return json(res,200,{user:{id:found.rows[0].id,email,role:found.rows[0].role},expiresAt:expires});
    }
    if(path==='/api/auth/me'&&req.method==='GET'){const user=await requireAuth(req,res,'worker');return user&&json(res,200,{user})}
    if(path==='/api/auth/logout'&&req.method==='POST'){
      if(!sameOrigin(req))return json(res,403,{error:'Cross-origin request blocked'});
      const token=parseCookies(req)[cookieName];if(token)await query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(token)]);clearCookie(res);return json(res,200,{ok:true});
    }
    const minimum=routeRole(req.method,path);
    if(minimum){if(!sameOrigin(req))return json(res,403,{error:'Cross-origin request blocked'});const user=await requireAuth(req,res,minimum);if(!user)return;
      req.user=user;
    }
    if(path==='/api/users'&&req.method==='GET'){const {rows}=await query(`SELECT id,email,role,active,created_at AS "createdAt" FROM users ORDER BY email`);return json(res,200,rows)}
    if(path==='/api/users'&&req.method==='POST'){
      const input=await body(req);const email=String(input?.email||'').trim().toLowerCase();const role=input?.role;const passcode=String(input?.password||'');
      if(!email||!['admin','manager','worker'].includes(role)||passcode.length<12)return json(res,400,{error:'email, exact role, and a 12+ character password are required'});
      try{const hash=await bcrypt.hash(passcode,12);const {rows}=await query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) RETURNING id,email,role,active`,[email,hash,role]);return json(res,201,rows[0])}catch(err){if(err.code==='23505')return json(res,409,{error:'Email already exists'});throw err}
    }
    const userMatch=path.match(/^\/api\/users\/([^/]+)$/);
    if(userMatch&&req.method==='PATCH'){
      const input=await body(req);const id=userMatch[1];const current=(await query('SELECT id,role,active FROM users WHERE id=$1',[id])).rows[0];if(!current)return json(res,404,{error:'User not found'});
      const nextRole=input?.role||current.role,nextActive=input?.active===undefined?current.active:!!input.active;
      if(input?.password&&String(input.password).length<12)return json(res,400,{error:'Password must be at least 12 characters'});
      const passcode=input?.password?await bcrypt.hash(String(input.password),12):null;
      if(!['admin','manager','worker'].includes(nextRole))return json(res,400,{error:'Invalid role'});
      if(current.role==='admin'&&(!nextActive||nextRole!=='admin')){const count=Number((await query(`SELECT count(*) FROM users WHERE role='admin' AND active`)).rows[0].count);if(count<=1)return json(res,400,{error:'The last active admin cannot be removed or demoted'})}
      const {rows}=await query(`UPDATE users SET role=$2,active=$3,password_hash=COALESCE($4,password_hash),updated_at=now() WHERE id=$1 RETURNING id,email,role,active`,[id,nextRole,nextActive,passcode]);return json(res,200,rows[0]);
    }
    if(path==='/api/day'&&req.method==='GET'){
      const now=new Date();const date=warehouseDateAt(now);const client=await pool.connect();try{await client.query('BEGIN');const cycle=await openCycle(client,date,'system','auto',now);const {rows}=await client.query(`SELECT dc.warehouse_date AS "warehouseDate",dc.cycle_number AS "cycleNumber",dc.started_at AS "startedAt",dc.started_by AS "startedBy",dc.start_mode AS "startMode",COUNT(da.id)::int AS assignments FROM daily_cycles dc LEFT JOIN daily_assignments da ON da.cycle_id=dc.id WHERE dc.id=$1 GROUP BY dc.id`,[cycle.id]);await client.query('COMMIT');return json(res,200,rows[0])}catch(err){await client.query('ROLLBACK');throw err}finally{client.release()}
    }
    if(path==='/api/day/reset'&&req.method==='POST'){
      const date=warehouseDate();const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`dockflow:${date}`]);const current=await client.query(`SELECT * FROM daily_cycles WHERE warehouse_date=$1 AND status='open' ORDER BY cycle_number DESC LIMIT 1 FOR UPDATE`,[date]);if(current.rows[0])await closeCycle(client,current.rows[0]);const cycle=await openCycle(client,date,req.user.id,'manual');await client.query('COMMIT');return json(res,201,{warehouseDate:date,cycleNumber:cycle.cycle_number,startedAt:cycle.started_at,startedBy:cycle.started_by,startMode:cycle.start_mode,assignments:0})}catch(err){await client.query('ROLLBACK');throw err}finally{client.release()}
    }
    if(path==='/api/boxes'&&req.method==='GET'){const {rows}=await query(`SELECT b.box_id AS "boxId",b.sku,b.quantity AS qty,p.name,b.status,b.received_at AS "receivedAt" FROM boxes b JOIN products p USING(sku) ORDER BY b.box_id`);return json(res,200,rows)}
    const boxMatch=path.match(/^\/api\/boxes\/([^/]+)$/);if(boxMatch&&req.method==='GET'){const {rows}=await query(`SELECT b.box_id AS "boxId",b.sku,b.quantity AS qty,p.name,b.status,b.received_at AS "receivedAt" FROM boxes b JOIN products p USING(sku) WHERE b.box_id=$1`,[boxMatch[1].toUpperCase()]);return rows[0]?json(res,200,rows[0]):json(res,404,{error:'Box not found'})}
    if(path==='/api/locations'&&req.method==='GET'){
      const date=warehouseDate();const {rows}=await query(`SELECT sl.location_number AS location,sl.capacity,da.sku,COALESCE(SUM(s.qty),0)::int AS filled FROM sorting_locations sl LEFT JOIN daily_cycles dc ON dc.warehouse_date=$1 AND dc.status='open' LEFT JOIN daily_assignments da ON da.cycle_id=dc.id AND da.location_number=sl.location_number LEFT JOIN scan_events s ON s.cycle_id=dc.id AND s.location_number=sl.location_number GROUP BY sl.location_number,sl.capacity,da.sku ORDER BY sl.location_number`,[date]);return json(res,200,rows)
    }
    if(path==='/api/assignments'&&req.method==='GET'){
      const date=warehouseDate();const {rows}=await query(`SELECT da.location_number AS location,da.sku,da.capacity,COALESCE(SUM(s.qty),0)::int AS filled,da.assigned_at AS "assignedAt" FROM daily_assignments da JOIN daily_cycles dc ON dc.id=da.cycle_id LEFT JOIN scan_events s ON s.cycle_id=da.cycle_id AND s.location_number=da.location_number WHERE dc.warehouse_date=$1 AND dc.status='open' GROUP BY da.id ORDER BY da.location_number`,[date]);return json(res,200,rows)
    }
    if(path==='/api/archive'&&req.method==='GET'){
      const from=archiveDate(url.searchParams.get('from')||url.searchParams.get('date')),to=archiveDate(url.searchParams.get('to')||from);
      if(!from||!to||from>to)return json(res,400,{error:'from and to must be valid YYYY-MM-DD dates'});
      const {clauses,values}=archiveFilters(url.searchParams,3);const where=`s.warehouse_date BETWEEN $1 AND $2${clauses.length?' AND '+clauses.join(' AND '):''}`;
      const {rows}=await query(`SELECT s.warehouse_date AS "warehouseDate",COUNT(*)::int AS "scannedBoxes",COALESCE(SUM(s.qty),0)::int AS units,COUNT(DISTINCT s.sku)::int AS skus,COUNT(DISTINCT s.location_number)::int AS locations,COUNT(DISTINCT s.user_id)::int AS users,COUNT(DISTINCT s.device_id)::int AS devices FROM scan_events s WHERE ${where} GROUP BY s.warehouse_date ORDER BY s.warehouse_date DESC`,[from,to,...values]);return json(res,200,rows)
    }
    if(path==='/api/archive/export'&&req.method==='GET'){
      const from=archiveDate(url.searchParams.get('from')),to=archiveDate(url.searchParams.get('to'));
      if(!from||!to||from>to)return json(res,400,{error:'from and to must be valid YYYY-MM-DD dates'});
      const {clauses,values}=archiveFilters(url.searchParams,3);const where=`s.warehouse_date BETWEEN $1 AND $2${clauses.length?' AND '+clauses.join(' AND '):''}`;
      const {rows}=await query(`SELECT s.warehouse_date AS date,s.box_id AS "boxId",s.sku,p.name,s.qty,s.location_number AS location,s.inbound_id AS "inboundId",s.client_id AS client,s.user_id AS "userId",s.device_id AS "deviceId",s.scanned_at AS "scannedAt" FROM scan_events s JOIN products p USING(sku) WHERE ${where} ORDER BY s.warehouse_date DESC,s.scanned_at DESC`,[from,to,...values]);
      const header=['Date','Box ID','SKU','Product','Quantity','Location','Inbound','Client','User','Device','Scanned At'];const lines=[header,...rows.map(r=>[r.date,r.boxId,r.sku,r.name,r.qty,r.location?`LOCATION ${r.location}`:'',r.inboundId,r.client,r.userId,r.deviceId,r.scannedAt])].map(row=>row.map(csvCell).join(','));
      res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="dockflow-${from}-to-${to}.csv"`});return res.end(lines.join('\n'))
    }
    const archiveDayMatch=path.match(/^\/api\/archive\/(\d{4}-\d{2}-\d{2})(?:\/(csv))?$/);
    if(archiveDayMatch&&req.method==='GET'){
      const date=archiveDate(archiveDayMatch[1]);const {clauses,values}=archiveFilters(url.searchParams,2);const where=`s.warehouse_date=$1${clauses.length?' AND '+clauses.join(' AND '):''}`;
      const {rows}=await query(`SELECT s.box_id AS "boxId",s.sku,p.name,s.qty,s.location_number AS location,s.inbound_id AS "inboundId",s.client_id AS client,s.user_id AS "userId",s.device_id AS "deviceId",s.scanned_at AS "scannedAt" FROM scan_events s JOIN products p USING(sku) WHERE ${where} ORDER BY s.scanned_at DESC`,[date,...values]);
      const exceptions=(await query(`SELECT e.id,e.box_id AS "boxId",e.reason,e.status,e.user_id AS "userId",e.device_id AS "deviceId",e.created_at AS "createdAt" FROM exceptions e WHERE e.warehouse_date=$1 OR (e.warehouse_date IS NULL AND e.box_id IN (SELECT box_id FROM scan_events WHERE warehouse_date=$1)) ORDER BY e.created_at DESC`,[date])).rows;
      if(archiveDayMatch[2]){const header=['Date','Box ID','SKU','Product','Quantity','Location','Inbound','Client','User','Device','Scanned At'];const lines=[header,...rows.map(r=>[date,r.boxId,r.sku,r.name,r.qty,r.location?`LOCATION ${r.location}`:'',r.inboundId,r.client,r.userId,r.deviceId,r.scannedAt])].map(row=>row.map(csvCell).join(','));res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="dockflow-${date}.csv"`});return res.end(lines.join('\n'))}
      const totals={scannedBoxes:rows.length,units:rows.reduce((n,r)=>n+r.qty,0),skus:new Set(rows.map(r=>r.sku)).size,locations:new Set(rows.map(r=>r.location).filter(Boolean)).size,users:new Set(rows.map(r=>r.userId)).size,devices:new Set(rows.map(r=>r.deviceId)).size};
      return json(res,200,{date,totals,assignments:rows,exceptions})
    }
    if(path==='/api/history'&&req.method==='GET'){const q=(url.searchParams.get('q')||'').trim();const {rows}=await query(`SELECT s.box_id AS "boxId",s.sku,s.qty,s.location_number AS loc,s.warehouse_date AS "warehouseDate",s.user_id AS "userId",s.device_id AS "deviceId",s.scanned_at AS "scannedAt",p.name FROM scan_events s JOIN products p USING(sku) WHERE ($1='' OR s.box_id ILIKE '%'||$1||'%' OR s.sku ILIKE '%'||$1||'%') ORDER BY s.scanned_at DESC LIMIT 200`,[q]);return json(res,200,rows)}
    if(path==='/api/exceptions'&&req.method==='GET'){const {rows}=await query(`SELECT id,box_id AS box,reason,status,warehouse_date AS "warehouseDate",resolved_at AS "resolvedAt" FROM exceptions ORDER BY (status='open') DESC,created_at DESC`);return json(res,200,rows)}
    const exceptionMatch=path.match(/^\/api\/exceptions\/([^/]+)\/resolve$/);if(exceptionMatch&&req.method==='POST'){const {rows}=await query(`UPDATE exceptions SET status='resolved',resolved_at=now() WHERE id=$1 RETURNING id,box_id AS box,reason,status,resolved_at AS "resolvedAt"`,[exceptionMatch[1]]);return rows[0]?json(res,200,rows[0]):json(res,404,{error:'Exception not found'})}
    if(path==='/api/scans'&&req.method==='POST'){
      const input=await body(req);if(!input)return json(res,400,{error:'Invalid JSON'});const boxId=String(input.boxId||'').trim().toUpperCase();if(!boxId)return json(res,400,{error:'boxId is required'});
      const client=await pool.connect();try{
        await client.query('BEGIN');const scannedAt=new Date();const date=warehouseDateAt(scannedAt);const found=await client.query('SELECT b.*,p.name FROM boxes b JOIN products p USING(sku) WHERE b.box_id=$1 FOR UPDATE',[boxId]);let box=found.rows[0];
        if(!box){if(!input.sku||!Number.isInteger(input.qty)||input.qty<1){await client.query('ROLLBACK');return json(res,400,{error:'Unknown box; sku and positive integer qty are required'})}box=(await client.query(`INSERT INTO boxes(box_id,sku,quantity,status) VALUES($1,$2,$3,'pending') RETURNING *`,[boxId,String(input.sku).trim().toUpperCase(),input.qty])).rows[0]}
        const existing=await client.query(`SELECT box_id AS "boxId",sku,qty,location_number AS destination,scanned_at AS "scannedAt" FROM scan_events WHERE box_id=$1`,[boxId]);if(existing.rows[0]){await client.query('ROLLBACK');return json(res,409,{error:'Duplicate scan',previous:existing.rows[0]})}
        const cycle=await openCycle(client,date,req.user.id,'auto',scannedAt);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`dockflow:assignments:${cycle.id}`]);
        const skuAssignments=(await client.query(`SELECT da.* FROM daily_assignments da WHERE da.cycle_id=$1 AND da.sku=$2 ORDER BY da.location_number FOR UPDATE`,[cycle.id,box.sku])).rows;
        let assignment=null;
        for(const candidate of skuAssignments){const filled=Number((await client.query(`SELECT COALESCE(SUM(qty),0)::int AS filled FROM scan_events WHERE cycle_id=$1 AND location_number=$2`,[cycle.id,candidate.location_number])).rows[0].filled);if(filled+box.quantity<=candidate.capacity){assignment=candidate;break}}
        if(!assignment){
          const next=(await client.query(`SELECT sl.* FROM sorting_locations sl WHERE NOT EXISTS (SELECT 1 FROM daily_assignments da WHERE da.cycle_id=$1 AND da.location_number=sl.location_number) ORDER BY sl.location_number LIMIT 1 FOR UPDATE`,[cycle.id])).rows[0];
          if(!next){await client.query(`INSERT INTO exceptions(box_id,reason,warehouse_date,user_id,device_id) VALUES($1,$2,$3,$4,$5)`,[boxId,'NO AVAILABLE SORTING LOCATION',date,req.user.id,input.deviceId||'unknown']);await client.query('COMMIT');return json(res,409,{error:'NO AVAILABLE SORTING LOCATION',exception:true})}
          assignment=(await client.query(`INSERT INTO daily_assignments(cycle_id,warehouse_date,sku,location_number,capacity,assigned_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[cycle.id,date,box.sku,next.location_number,next.capacity,req.user.id])).rows[0];
        }
        const event=(await client.query(`INSERT INTO scan_events(box_id,sku,qty,destination,location_number,warehouse_date,cycle_id,user_id,device_id,inbound_id,client_id,box_sequence,scanned_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING box_id AS "boxId",sku,qty,location_number AS destination,warehouse_date AS "warehouseDate",scanned_at AS "scannedAt",user_id AS "userId",device_id AS "deviceId"`,[boxId,box.sku,box.quantity,`LOCATION ${assignment.location_number}`,assignment.location_number,date,cycle.id,req.user.id,input.deviceId||'unknown',input.inboundId||null,input.clientId||null,input.boxSequence||null,scannedAt])).rows[0];
        await client.query(`UPDATE boxes SET status='received',received_at=COALESCE(received_at,now()) WHERE box_id=$1`,[boxId]);await client.query('COMMIT');return json(res,201,event);
      }catch(err){await client.query('ROLLBACK');if(err.code==='23505')return json(res,409,{error:'Duplicate scan'});if(err.code==='23503')return json(res,400,{error:'SKU does not exist'});throw err}finally{client.release()}
    }
    if(path.startsWith('/api/'))return json(res,404,{error:'Not found'});
    if(path==='/setup'&&process.env.NODE_ENV==='production'&&!requestIsHttps(req))return bootstrapError(res);
    const relative=path==='/'?'index.html':path.slice(1);const file=normalize(join(root,relative));
    if(!file.startsWith(root))return json(res,404,{error:'Not found'});
    let resolved=file;
    try{if(!(await stat(resolved)).isFile())throw new Error('not a file')}catch{
      // Client-side routes are served by the single-page app, but missing assets are real 404s.
      if(path.includes('.')||req.method!=='GET')return json(res,404,{error:'Not found'});
      resolved=join(root,'index.html');
    }
    const data=await readFile(resolved);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.jsx':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};res.writeHead(200,{'content-type':types[extname(resolved)]||'application/octet-stream','cache-control':path==='/setup'||path.startsWith('/api/')?'no-store':'public, max-age=0, must-revalidate'});res.end(data);
  }catch(err){console.error(err);json(res,500,{error:'Internal server error'})}
});
if(process.argv[1]===fileURLToPath(import.meta.url)){if(!process.env.DATABASE_URL)console.error('DATABASE_URL is not set; API requests will return 503');server.listen(Number(process.env.PORT)||3000,()=>console.log(`DockFlow running on port ${process.env.PORT||3000}`))}
export {server,warehouseDate};
