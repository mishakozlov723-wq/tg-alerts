import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {ALERTS_SESSION_NOT_BEFORE,verifyAccessToken} from '../shared/access-token.mjs'
const secret='artificial-session-test-key'
const sign=payload=>{const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return body+'.'+createHmac('sha256',secret).update(body).digest('hex')}
const session=(extra={})=>({sub:'test-user',project:'alerts',iat:Date.now(),exp:Date.now()+96*3600000,...extra})
test('server rejects old still-unexpired Alerts sessions',()=>{
 const old=session({iat:ALERTS_SESSION_NOT_BEFORE-1})
 assert.ok(old.exp>Date.now());assert.equal(verifyAccessToken(sign(old),'alerts',secret),null)
})
test('reset boundary is inclusive and new sessions retain their 96h expiry',()=>{
 const boundary=session({iat:ALERTS_SESSION_NOT_BEFORE})
 assert.deepEqual(verifyAccessToken(sign(boundary),'alerts',secret),boundary)
 const fresh=session();fresh.exp=fresh.iat+96*3600000
 assert.deepEqual(verifyAccessToken(sign(fresh),'alerts',secret),fresh)
 assert.equal(fresh.exp-fresh.iat,96*3600000)
})
test('missing or nonnumeric Alerts issued-at cannot bypass reset',()=>{
 for(const iat of [undefined,null,'9999999999999',false])assert.equal(verifyAccessToken(sign(session({iat})),'alerts',secret),null)
})
test('signature, expiry and project binding remain enforced',()=>{
 const fresh=session(),token=sign(fresh)
 assert.equal(verifyAccessToken(token,'calendar',secret),null)
 assert.equal(verifyAccessToken(token,'alerts','wrong-key'),null)
 assert.equal(verifyAccessToken(sign(session({exp:Date.now()-1})),'alerts',secret),null)
 const [body,sig]=token.split('.')
 const modified=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body,'base64url')),iat:ALERTS_SESSION_NOT_BEFORE+1})).toString('base64url')
 assert.equal(verifyAccessToken(modified+'.'+sig,'alerts',secret),null)
})
test('Alerts reset does not revoke Calendar sessions',()=>{
 const calendar=session({project:'calendar',iat:ALERTS_SESSION_NOT_BEFORE-100000})
 assert.deepEqual(verifyAccessToken(sign(calendar),'calendar',secret),calendar)
})
