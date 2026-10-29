// Dev-only cleanup of OLD simulated/demo chat messages ("SIMULATED DEMO REPLY").
// Run: node scripts/cleanupDemoChats.js
//
// Real conversations are preserved: only assistant messages that were generated
// by the old local demo fallback are removed. Chats that become empty are deleted.
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Chat = require('../models/Chat');

const DEMO_PATTERN = /SIMULATED DEMO REPLY|simulated demo|demo reply/i;

const main = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Create backend/.env from .env.example first.');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  const query = { 'messages.content': DEMO_PATTERN };
  const total = await Chat.countDocuments(query);
  console.log(`Found ${total} conversation(s) containing old simulated/demo messages.`);

  const chats = await Chat.find(query).select('messages').lean();
  let removedMessages = 0;
  let deletedChats = 0;

  for (const chat of chats) {
    const kept = (chat.messages || []).filter((m) => !DEMO_PATTERN.test(m.content || ''));
    const removed = chat.messages.length - kept.length;
    if (kept.length === 0) {
      await Chat.deleteOne({ _id: chat._id });
      deletedChats += 1;
    } else {
      await Chat.updateOne({ _id: chat._id }, { $set: { messages: kept } });
    }
    removedMessages += removed;
    console.log(`  chat ${chat._id}: removed ${removed} demo message(s) -> ${kept.length === 0 ? 'deleted chat' : `${kept.length} message(s) kept`}`);
  }

  console.log(`\nDone: removed ${removedMessages} demo message(s), deleted ${deletedChats} empty demo chat(s).`);
  console.log('No real user conversations were destroyed.');
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});