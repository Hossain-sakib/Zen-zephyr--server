const { ObjectId } = require('mongodb');
const { createHash } = require('node:crypto');
const { copyImage } = require('./image-migration');
const people = [
 ['ayesha-rahman','Ayesha Rahman','Dhaka','Demo profile · Finding joy in everyday moments, good food and small creative projects.'],
 ['maya-chen','Maya Chen','Singapore','Demo profile · Curious about design, thoughtful spaces and making things easier to use.'],
 ['noah-patel','Noah Patel','London','Demo profile · Books, long walks and conversations that open a new perspective.'],
 ['zara-khan','Zara Khan','Toronto','Demo profile · Asking better questions and learning something new every week.'],
 ['omar-farid','Omar Farid','Dubai','Demo profile · Building useful things and sharing what makes technology more human.'],
 ['elena-park','Elena Park','Seoul','Demo profile · Plant enthusiast, weekend sketcher and collector of little ideas.'],
 ['rafi-ahmed','Rafi Ahmed','Dhaka','Demo profile · Learning in public, one small project at a time.'],
 ['sofia-morales','Sofia Morales','Barcelona','Demo profile · Art, stories and the books that stay with us.'],
 ['kaito-mori','Kaito Mori','Kyoto','Demo profile · Photography, natural light and noticing the details.'],
 ['lucas-bennett','Lucas Bennett','Melbourne','Demo profile · Spaces, making things by hand and good conversations.'],
 ['lina-haddad','Lina Haddad','Amman','Demo profile · Community projects, thoughtful questions and everyday kindness.'],
 ['mateo-santos','Mateo Santos','Lisbon','Demo profile · Music, cooking and finding fresh inspiration close to home.'],
];
const photos = {
 workspace:'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1200&q=85',
 coffee:'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=85',
 mountains:'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1200&q=85',
 books:'https://images.unsplash.com/photo-1507842217343-583bb7270b66?auto=format&fit=crop&w=1200&q=85',
 architecture:'https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=1200&q=85',
 plants:'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=1200&q=85',
};
const posts = [
 ['maya-chen','Design','A tiny design challenge for today: take one screen you use every day and remove one unnecessary step. What would you simplify—and why?','workspace',[[3,'The checkout flow on almost every website. Fewer surprises, clearer totals.'],[9,'I would make important settings easier to find. A useful label beats a clever icon.'],[6,'Great prompt. I’m trying this on a little project I’m building.']]],
 ['ayesha-rahman','Everyday life','Small wins count. Finish the task you’ve been postponing, water your plants, or take a proper lunch break. What’s one small win you’re celebrating today?','coffee',[[5,'My first new leaf on a plant I thought I had lost!'],[2,'Finished a book that had been sitting on my shelf for months.'],[11,'Cooked a proper meal instead of eating at my desk. That counts, right?']]],
 ['kaito-mori','Photography','Good light makes even familiar places feel new. If you could photograph just one thing this weekend, what would it be?','mountains',[[9,'The old buildings in my neighborhood, before the morning gets busy.'],[0,'A quiet corner of the city at sunrise.'],[7,'People making things with their hands. There is always a story there.']]],
 ['omar-farid','Technology','What’s one tool that genuinely saves you time? Not the trendiest one—the one you’d miss tomorrow. I’m always interested in the small, practical things people actually use.','',[[6,'A notes app with a quick capture shortcut. Ideas disappear fast!'],[1,'Browser profiles for different projects. Less tab chaos.'],[3,'A simple shared calendar. Nothing fancy, just actually using it.']]],
 ['sofia-morales','Art & culture','Let’s build a recommendation thread. What’s a book, film or album that stayed with you long after you finished it—and what made it stick?','books',[[2,'The Little Prince. It feels different every time I reread it.'],[10,'A documentary about people restoring a neighborhood garden. Small actions adding up.'],[11,'An album connected to a road trip. Sometimes the memory is half the music.']]],
 ['zara-khan','Questions','You get one extra free hour every day, but you can’t spend it on a screen. How are you using it?','',[[5,'Pottery. I love the idea of making something slowly.'],[8,'A walk without headphones. There is so much we tune out.'],[0,'A longer breakfast with the people I care about.']]],
 ['lucas-bennett','Design','Good spaces make room for people. Natural light, a comfortable chair, a quiet corner—what makes a place feel welcoming to you?','architecture',[[1,'Somewhere to sit without feeling like I’m in the way.'],[7,'Warm lighting and something with a story behind it.'],[10,'A place that is easy to enter, navigate and enjoy for everyone.']]],
 ['elena-park','Everyday life','A little green can change a whole corner of a room. Beginner plant people: what survived your learning curve? Share the resilient favorites.','plants',[[0,'Pothos! It forgives a lot.'],[9,'A snake plant that seems happier when I stop fussing over it.'],[3,'Learning to check the soil instead of watering on a strict schedule helped me.']]],
 ['rafi-ahmed','Technology','Build in public, but share the messy middle too. What’s something you’re learning right now that still feels wonderfully difficult?','',[[4,'Explaining a complicated idea in one simple paragraph.'],[11,'Getting the timing right when I cook for more than two people.'],[1,'Knowing when to stop adding features and listen to someone using the thing.']]],
 ['noah-patel','Everyday life','A weekend thought: you don’t always need a bigger plan. Sometimes you need a longer walk. What’s your favorite way to reset after a busy week?','',[[8,'Somewhere with trees and no particular destination.'],[5,'Making something with my hands, even if it isn’t very good yet.'],[7,'A slow afternoon and a very good playlist.']]],
];
function seedId(key, date) {
 return new ObjectId(Math.floor(date.getTime()/1000).toString(16).padStart(8,'0')+createHash('sha256').update(key).digest('hex').slice(0,16));
}
async function seedProfiles(db) {
 let created=0;
 for(const [slug,name,location,bio] of people){const key='community-demo/profile/'+slug;const result=await db.users.updateOne({uid:'demo-'+slug},{$setOnInsert:{_id:seedId(key,new Date()),uid:'demo-'+slug,email:null,name,location,bio,userImage:'',role:'user',badge:'bronze',isDemo:true,seedKey:key,joinedAt:new Date().toISOString()}},{upsert:true});created+=result.upsertedCount||0;}
 return {created,total:people.length};
}
async function seedPost(db,index) {
 if(!Number.isInteger(index)||index<0||index>=posts.length)throw new Error('Invalid demo post');
 const [slug,topic,content,photo,comments]=posts[index];const person=people.find(p=>p[0]===slug);const key='community-demo/post/'+index;
 let post=await db.posts.findOne({seedKey:key});let uploaded=false;
 if(!post){const createdAt=new Date(Date.now()-(index+1)*23*60*1000);const image=photo?(await copyImage(photos[photo])).url:'';uploaded=!!image;
 const record={_id:seedId(key,createdAt),authorUid:'demo-'+slug,authorEmail:null,authorName:person[1],authorImage:'',title:content.slice(0,100),description:content,tag:topic,visibility:'public',imageUrl:image,upVotes:[],downVotes:[],createdAt:createdAt.toISOString(),isDemo:true,seedKey:key,imageSource:photo?photos[photo]:null};
 await db.posts.updateOne({seedKey:key},{$setOnInsert:record},{upsert:true});post=await db.posts.findOne({seedKey:key});}
 let createdComments=0;
 for(let i=0;i<comments.length;i++){const [personIndex,content]=comments[i];const author=people[personIndex];const commentKey=key+'/comment/'+i;const createdAt=new Date(new Date(post.createdAt).getTime()+(i+1)*3*60*1000);
 const result=await db.comments.updateOne({seedKey:commentKey},{$setOnInsert:{_id:seedId(commentKey,createdAt),postId:String(post._id),commenterUid:'demo-'+author[0],commenterName:author[1],commenterImage:'',commenterEmail:null,comment:content,createdAt:createdAt.toISOString(),isDemo:true,seedKey:commentKey}},{upsert:true});createdComments+=result.upsertedCount||0;}
 return {post:index+1,id:String(post._id),createdComments,imageCopied:uploaded};
}
module.exports={seedProfiles,seedPost,people,photos};
