const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-resume-career');
  const db = mongoose.connection.db;
  const raw = await db.collection('chats').find({ 'messages.image': { $exists: true } }).sort({ createdAt: -1 }).limit(2).toArray();
  raw.forEach((c) => {
    console.log('CHAT', c._id, JSON.stringify(c.title), c.createdAt.toISOString());
    (c.messages || []).forEach((m, i) => {
      if (m.image) {
        console.log(`  [${i}] role=${m.role} followUp=${m.image.isFollowUp}`);
        console.log('      prompt    =', JSON.stringify(m.image.prompt));
        console.log('      basePrompt=', JSON.stringify(m.image.basePrompt));
        console.log('      imageId   =', m.image.imageId);
      } else {
        console.log(`  [${i}] role=${m.role} content=${JSON.stringify(String(m.content || '').slice(0, 70))}`);
      }
    });
  });
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });