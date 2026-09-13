import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('server uses PostgreSQL and production PORT',async()=>{const source=await readFile(new URL('../server.js',import.meta.url),'utf8');assert.match(source,/process\.env\.DATABASE_URL/);assert.match(source,/process\.env\.PORT/);assert.match(source,/scan_events/)});
test('schema contains the complete persistent model',async()=>{const schema=await readFile(new URL('../db/schema.sql',import.meta.url),'utf8');for(const table of ['products','locations','routing_rules','boxes','scan_events','exceptions'])assert.match(schema,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));});
test('frontend uses same-origin APIs without demo catalog',async()=>{const source=await readFile(new URL('../app.jsx',import.meta.url),'utf8');assert.match(source,/fetch\('/api\//);assert.doesNotMatch(source,/const boxes=\{/);});
