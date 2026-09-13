import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('.',import.meta.url));
const boxes={ 'BOX-1042':{boxId:'BOX-1042',sku:'SKU-ALP-01',qty:24,name:'Alpine Trail Bottle'},'BOX-1043':{boxId:'BOX-1043',sku:'SKU-BLU-07',qty:12,name:'Blue Ridge Mug'},'BOX-1044':{boxId:'BOX-1044',sku:'SKU-ALP-01',qty:18,name:'Alpine Trail Bottle'},'BOX-1045':{boxId:'BOX-1045',sku:'SKU-CED-03',qty:8,name:'Cedar Camp Towel'} };
const send=(res,status,data,type='application/json')=>{res.writeHead(status,{'content-type':type,'access-control-allow-origin':'*'});res.end(type==='application/json'?JSON.stringify(data):data)};
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST','access-control-allow-headers':'content-type'});return res.end()}
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/api/health')return send(res,200,{ok:true,service:'dockflow'});
  if(path==='/api/boxes'&&req.method==='GET')return send(res,200,Object.values(boxes));
  const match=path.match(/^\/api\/boxes\/([^/]+)$/);
  if(match&&req.method==='GET')return boxes[match[1].toUpperCase()]?send(res,200,boxes[match[1].toUpperCase()]):send(res,404,{error:'Box not found'});
  if(path.startsWith('/api/'))return send(res,404,{error:'Not found'});
  const file=path==='/'?'index.html':path.slice(1);
  try{const data=await readFile(join(root,file));const types={'.html':'text/html','.js':'text/javascript','.jsx':'text/javascript','.css':'text/css'};send(res,200,data,types[extname(file)]||'text/plain')}catch{send(res,404,'Not found','text/plain')}
});
if (process.argv[1]===fileURLToPath(import.meta.url)) server.listen(process.env.PORT||3000,()=>console.log(`DockFlow running at http://localhost:${process.env.PORT||3000}`));
export {server,boxes};
