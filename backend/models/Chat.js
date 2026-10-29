const mongoose = require('mongoose');

const resourceSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    type: { type: String, default: 'resource' },
    difficulty: { type: String, default: '' },
    url: { type: String, required: true },
  },
  { _id: false }
);

const sourceSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    url: { type: String, required: true },
    domain: { type: String, default: '' },
    snippet: { type: String, default: '' },
  },
  { _id: false }
);

// A real generated image attached to an assistant message. Only metadata is
// stored here — the bytes live in GeneratedImage (ownership-checked) so a chat
// document never carries megabytes of base64.
const imageSchema = new mongoose.Schema(
  {
    imageId: { type: mongoose.Schema.Types.ObjectId, ref: 'GeneratedImage', required: true },
    prompt: { type: String, default: '' },
    basePrompt: { type: String, default: '' },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    isFollowUp: { type: Boolean, default: false },
  },
  { _id: false }
);

const completionSchema = new mongoose.Schema(
  {
    complete: { type: Boolean, required: true },
    kind: { type: String, default: 'none' },
    requested: { type: Number, default: null },
    produced: { type: Number, default: null },
    nextIndex: { type: Number, default: null },
    target: { type: Number, default: null },
    reason: { type: String, default: '' },
    finishReason: { type: String, default: '' },
    providerTruncated: { type: Boolean, default: false },
    continuationAttempts: { type: Number, default: 0 },
    failure: { type: String, default: '' },
    stopped: { type: String, default: '' },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    resources: { type: [resourceSchema], default: undefined },
    sources: { type: [sourceSchema], default: undefined },
    image: { type: imageSchema, default: undefined },
    completion: { type: completionSchema, default: undefined },
    requestId: { type: String, default: undefined },
  },
  { timestamps: true }
);

const chatSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, default: 'New Conversation', maxlength: 200 },
    messages: [messageSchema],
  },
  { timestamps: true }
);

chatSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model('Chat', chatSchema);