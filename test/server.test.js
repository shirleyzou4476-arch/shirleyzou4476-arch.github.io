import test from 'node:test';
import assert from 'node:assert/strict';
import {boxes} from '../server.js';
test('demo box catalog contains routable sample labels',()=>{assert.equal(boxes['BOX-1042'].sku,'SKU-ALP-01');assert.equal(boxes['BOX-1042'].qty,24)});
test('all demo boxes have positive quantities',()=>{assert.ok(Object.values(boxes).every(box=>box.qty>0&&box.boxId.startsWith('BOX-')))});
