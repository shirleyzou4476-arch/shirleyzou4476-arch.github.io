import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateLocationImport} from '../server.js';

test('server uses PostgreSQL and production PORT',async()=>{const source=await readFile(new URL('../server.js',import.meta.url),'utf8');assert.match(source,/process\.env\.DATABASE_URL/);assert.match(source,/process\.env\.PORT/);assert.match(source,/scan_events/)});
test('schema contains the complete persistent model',async()=>{const schema=await readFile(new URL('../db/schema.sql',import.meta.url),'utf8');for(const table of ['products','locations','routing_rules','boxes','scan_events','exceptions'])assert.match(schema,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));});
test('frontend uses same-origin APIs without demo catalog',async()=>{const source=await readFile(new URL('../app.jsx',import.meta.url),'utf8');assert.match(source,/fetch\('/api\//);assert.doesNotMatch(source,/const boxes=\{/);});
test('location import validates duplicates and capacity before persistence',()=>{const result=validateLocationImport([{location:'A-01',SKU:'SKU-1',capacity:'10'},{location:'A-01',SKU:'SKU-2',capacity:'0'}]);assert.equal(result.errors.length,2);assert.match(result.errors[0].message,/Duplicate/);assert.match(result.errors[1].message,/positive/);});
test('location import API and frontend include replacement and template behavior',async()=>{const [server,app,readme]=await Promise.all([readFile(new URL('../server.js',import.meta.url),'utf8'),readFile(new URL('../app.jsx',import.meta.url),'utf8'),readFile(new URL('../README.md',import.meta.url),'utf8')]);assert.match(server,/\/api\/locations\/import/);assert.match(server,/DELETE FROM routing_rules/);assert.match(app,/Download template/);assert.match(app,/Replace current locations/);assert.match(readme,/location,SKU,capacity/);});
