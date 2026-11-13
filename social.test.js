const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const serverless = require('serverless-http');
const { createApp } = require('./index');
const value = x => x instanceof ObjectId ? String(x) : x instanceof Date ? x.getTime() : x;
const eq = (a, b) => Array.isArray(a) ? a.some(x => eq(x, b)) : value(a) === value(b);
function matches(doc, query = {}) {
 return Object.entries(query).every(([key, expected]) => {
  if (key === '$or') return expected.some(q => matches(doc, q));
  if (key === '$and') return expected.every(q => matches(doc, q));
  const actual = doc[key];
  if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) return Object.entries(expected).every(([op, v]) => {
   if (op === '$ne') return !eq(actual, v); if (op === '$in') return v.some(x => eq(actual, x)); if (op === '$nin') return !v.some(x => eq(actual, x));
   if (op === '$gt') return value(actual) > value(v); if (op === '$gte') return value(actual) >= value(v); if (op === '$lt') return value(actual) < value(v);
   if (op === '$regex') return new RegExp(v, expected.$options || '').test(actual || ''); if (op === '$options') return true;
   throw Error('Unsupported fixture operator ' + op);
  });
  return eq(actual, expected);
 });
}
function fixture() {
 const data = {};const names=['users','posts','comments','friendships','notifications','saved','reports','blocks','spaces','memberships','spacePosts','spaceComments','conversations','messages','conversationReads','stories','storyViews','events','rsvps','listings'];
 const db=Object.fromEntries(names.map(name=>{const rows=data[name]=[];return [name,{
  async findOne(q){return rows.find(row=>matches(row,q))||null},async countDocuments(q){return rows.filter(row=>matches(row,q)).length},
  find(q){let items=rows.filter(row=>matches(row,q));return{sort(order){const [key,dir]=Object.entries(order)[0];items.sort((a,b)=>value(a[key])<value(b[key])?-dir:value(a[key])>value(b[key])?dir:0);return this},limit(n){items=items.slice(0,n);return this},async toArray(){return [...items]}}},
  async insertOne(doc){const record={...doc,_id:doc._id||new ObjectId()};rows.push(record);return{insertedId:record._id}},
  async updateOne(q,update,options={}){let record=rows.find(row=>matches(row,q));let inserted=false;if(!record&&options.upsert){record={...q,_id:q._id||new ObjectId()};rows.push(record);inserted=true}if(!record)return{matchedCount:0,modifiedCount:0,upsertedCount:0};
   if(inserted)Object.assign(record,update.$setOnInsert||{});Object.assign(record,update.$set||{});
   for(const[k,v]of Object.entries(update.$max||{}))if(record[k]===undefined||value(record[k])<value(v))record[k]=v;
   for(const[k,v]of Object.entries(update.$addToSet||{})){if(!record[k])record[k]=[];if(!record[k].some(x=>eq(x,v)))record[k].push(v)}
   for(const[k,v]of Object.entries(update.$pull||{}))record[k]=(record[k]||[]).filter(x=>!eq(x,v));
   return{matchedCount:inserted?0:1,modifiedCount:1,upsertedCount:inserted?1:0,upsertedId:inserted?record._id:null};},
  async deleteOne(q){const i=rows.findIndex(row=>matches(row,q));if(i>=0)rows.splice(i,1);return{deletedCount:i>=0?1:0}},
  async deleteMany(q){const selected=rows.filter(row=>matches(row,q));for(const row of selected)rows.splice(rows.indexOf(row),1);return{deletedCount:selected.length}},
 }] }));
 const people=['alice','bob','charlie'].map(uid=>({uid,email:uid+'@example.test',name:uid[0].toUpperCase()+uid.slice(1),userImage:'',role:'user'}));data.users.push(...people.map(p=>({...p,_id:new ObjectId()})));
 const authenticate=(req,res,next)=>{const p=people.find(p=>req.headers.authorization==='Bearer '+p.uid);if(!p)return res.status(401).json({message:'Sign in required'});req.decoded=p;next()};
 const handler=serverless(createApp({getCollections:async()=>db,authenticate}));
 return{data,db,async request(url,method='GET',body,user){const[path,query]=url.split('?');const r=await handler({path:'/social'+path,httpMethod:method,headers:{'content-type':'application/json',...(user?{authorization:'Bearer '+user}:{})},body:body===undefined?null:JSON.stringify(body),queryStringParameters:Object.fromEntries(new URLSearchParams(query||'')),isBase64Encoded:false},{});return{status:r.statusCode,data:JSON.parse(r.body)}}};
}
const groupBody={type:'group',title:'Private design circle',description:'Thoughtful community discussions.',category:'Design',visibility:'private',image:''};
const listingBody={title:'Test bookshelf',description:'A useful shelf in good condition.',category:'Home',location:'Dhaka',price:1200,currency:'BDT',condition:'good',images:[]};
test('private group content is gated by approved membership',async()=>{const f=fixture();const g=await f.request('/spaces','POST',groupBody,'alice');assert.equal(g.status,201);const id=g.data.id;
 assert.equal((await f.request('/spaces/'+id+'/posts')).status,403);assert.equal((await f.request('/spaces/'+id+'/membership','PUT',{joined:true},'bob')).data.status,'pending');
 assert.equal((await f.request('/spaces/'+id+'/posts','GET',undefined,'bob')).status,403);
 assert.equal((await f.request('/spaces/'+id+'/members/bob','PATCH',{status:'joined'},'charlie')).status,403);
 assert.equal((await f.request('/spaces/'+id+'/members/bob','PATCH',{status:'joined'},'alice')).status,200);
 assert.equal((await f.request('/spaces/'+id+'/posts','POST',{content:'A real group discussion',ownerUid:'charlie'},'bob')).status,201);
 const posts=await f.request('/spaces/'+id+'/posts','GET',undefined,'alice');assert.equal(posts.data.items.length,1);assert.equal(posts.data.items[0].author.id,'bob');
});
test('banned group members cannot rejoin or access private posts',async()=>{const f=fixture();const id=(await f.request('/spaces','POST',groupBody,'alice')).data.id;
 await f.request('/spaces/'+id+'/membership','PUT',{joined:true},'bob');await f.request('/spaces/'+id+'/members/bob','PATCH',{status:'banned'},'alice');
 assert.equal((await f.request('/spaces/'+id+'/posts','GET',undefined,'bob')).status,403);assert.equal((await f.request('/spaces/'+id+'/membership','PUT',{joined:true},'bob')).status,403);
});
test('page followers cannot publish owner updates',async()=>{const f=fixture();const id=(await f.request('/spaces','POST',{...groupBody,type:'page'},'alice')).data.id;
 await f.request('/spaces/'+id+'/membership','PUT',{joined:true},'bob');assert.equal((await f.request('/spaces/'+id+'/posts','POST',{content:'Forged update'},'bob')).status,403);
 assert.equal((await f.request('/spaces/'+id+'/posts','POST',{content:'An official update'},'alice')).status,201);
 assert.equal((await f.request('/spaces/'+id,'PATCH',{...groupBody,title:'Forged'},'bob')).status,403);
});
test('only conversation participants can read and send messages',async()=>{const f=fixture();const id=(await f.request('/conversations','POST',{recipientUid:'bob'},'alice')).data.id;
 assert.equal((await f.request('/conversations/'+id+'/messages','GET',undefined,'charlie')).status,404);
 assert.equal((await f.request('/conversations/'+id+'/messages','POST',{content:'Intrusion',nonce:'intrusion-00000001'},'charlie')).status,404);
 const body={content:'Hello Bob',nonce:'message-nonce-000001',senderUid:'charlie'};
 assert.equal((await f.request('/conversations/'+id+'/messages','POST',body,'alice')).status,201);await f.request('/conversations/'+id+'/messages','POST',body,'alice');
 assert.equal(f.data.messages.length,1);assert.equal(f.data.messages[0].senderUid,'alice');
 assert.equal((await f.request('/conversations/unread','GET',undefined,'bob')).data.unread,1);
 const msgs=await f.request('/conversations/'+id+'/messages','GET',undefined,'bob');await f.request('/conversations/'+id+'/read','PUT',{lastMessageId:msgs.data.items[0].id},'bob');
 assert.equal((await f.request('/conversations/unread','GET',undefined,'bob')).data.unread,0);
});
test('message validation rejects malformed text, nonces and external attachments',async()=>{const f=fixture();const id=(await f.request('/conversations','POST',{recipientUid:'bob'},'alice')).data.id;
 for(const body of [{content:0,nonce:'message-nonce-00001'},{content:'Hello',nonce:123},{content:'Hello',nonce:'message-nonce-00001',image:'https://example.com/file.png'}])assert.equal((await f.request('/conversations/'+id+'/messages','POST',body,'alice')).status,400);
});
test('blocking revokes messaging and removes an existing connection',async()=>{const f=fixture();const id=(await f.request('/conversations','POST',{recipientUid:'bob'},'alice')).data.id;f.data.friendships.push({_id:require('./community').pairId('alice','bob'),members:['alice','bob'],status:'accepted'});
 assert.equal((await f.request('/blocks/alice','PUT',{blocked:true,ownerUid:'charlie'},'bob')).status,200);assert.equal(f.data.friendships.length,0);
 assert.equal((await f.request('/conversations/'+id+'/messages','POST',{content:'Not allowed',nonce:'message-nonce-000001'},'alice')).status,403);
 assert.equal((await f.request('/conversations','POST',{recipientUid:'bob'},'alice')).status,403);assert.equal(f.data.blocks[0].ownerUid,'bob');
 await f.request('/blocks/alice','PUT',{blocked:false},'bob');assert.equal((await f.request('/conversations/'+id+'/messages','POST',{content:'Allowed again',nonce:'message-nonce-000002'},'alice')).status,201);
});
test('stories expire server-side and clients cannot choose a different deadline or author',async()=>{const f=fixture();const r=await f.request('/stories','POST',{content:'A little moment',color:'lilac',visibility:'public',expiresAt:'2099-01-01',ownerUid:'bob'},'alice');assert.equal(r.status,201);
 const story=f.data.stories[0];assert.equal(story.ownerUid,'alice');assert.ok(Math.abs(new Date(story.expiresAt).getTime()-Date.now()-86400000)<10000);
 assert.equal((await f.request('/stories/'+r.data.id)).status,200);assert.equal((await f.request('/stories/'+r.data.id,'DELETE',undefined,'bob')).status,403);
 story.expiresAt=new Date(Date.now()-1000);assert.equal((await f.request('/stories/'+r.data.id)).status,404);assert.equal((await f.request('/stories/'+r.data.id+'/view','PUT',{},'bob')).status,404);
});
test('connections-only story cannot be read or counted by a stranger',async()=>{const f=fixture();const id=(await f.request('/stories','POST',{content:'Private moment',color:'sage',visibility:'connections'},'alice')).data.id;
 assert.equal((await f.request('/stories/'+id)).status,404);assert.equal((await f.request('/stories/'+id,'GET',undefined,'bob')).status,404);
 f.data.friendships.push({_id:require('./community').pairId('alice','bob'),members:['alice','bob'],status:'accepted'});
 assert.equal((await f.request('/stories/'+id+'/view','PUT',{uid:'charlie'},'bob')).status,200);await f.request('/stories/'+id+'/view','PUT',{},'bob');assert.equal(f.data.storyViews.length,1);assert.equal(f.data.storyViews[0].uid,'bob');
});
test('events enforce host ownership and idempotent personal RSVPs',async()=>{const f=fixture();const body={title:'A future meetup',description:'Good conversations in person.',location:'Dhaka',startsAt:new Date(Date.now()+86400000).toISOString(),ownerUid:'charlie'};const id=(await f.request('/events','POST',body,'alice')).data.id;
 assert.equal(f.data.events[0].ownerUid,'alice');assert.equal((await f.request('/events/'+id,'DELETE',undefined,'bob')).status,403);
 await f.request('/events/'+id+'/rsvp','PUT',{status:'going',uid:'charlie'},'bob');await f.request('/events/'+id+'/rsvp','PUT',{status:'going'},'bob');
 assert.equal((await f.request('/events/'+id,'GET',undefined,'bob')).data.going,1);assert.equal(f.data.rsvps[0].uid,'bob');
 assert.equal((await f.request('/events','POST',{...body,startsAt:'2020-01-01'},'alice')).status,400);
});
test('marketplace prices, photos and seller ownership are checked',async()=>{const f=fixture();const id=(await f.request('/listings','POST',{...listingBody,ownerUid:'charlie'},'alice')).data.id;
 assert.equal(f.data.listings[0].ownerUid,'alice');assert.equal((await f.request('/listings/'+id,'PATCH',{status:'sold'},'bob')).status,403);
 assert.equal((await f.request('/listings/'+id,'PATCH',{status:'sold'},'alice')).status,200);assert.equal((await f.request('/listings')).data.length,0);
 for(const body of [{...listingBody,price:-1},{...listingBody,images:['https://example.com/file.png']},{...listingBody,currency:'FAKE'}])assert.equal((await f.request('/listings','POST',body,'alice')).status,400);
});
