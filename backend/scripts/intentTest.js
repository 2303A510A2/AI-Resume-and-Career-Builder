// Deterministic unit test for the general image-operation detector.
// Run: node scripts/intentTest.js   (no network, no provider, no database)
//
// This is the guard rail for "general intent detection": nothing here is
// hard-coded to a subject, only to the OPERATION (generate / edit / understand
// / text / follow-up). A regression in this file means the chat router can
// start sending ordinary questions to the image provider, or can stop treating
// a plain-language request like "draw a cat" as an image at all.
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { detectImageOperation } = require('../services/imageIntent');

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, actual, expected) => {
  if (actual === expected) {
    passed += 1;
    console.log(`  OK   ${name} -> ${actual}`);
  } else {
    failed += 1;
    failures.push(`${name} (expected ${expected}, got ${actual})`);
    console.log(`  FAIL ${name} -> ${actual} (expected ${expected})`);
  }
};

const op = (message, extra) => detectImageOperation({ message, ...extra }).operation;

// A previous generated image is on screen (the conversational follow-up state).
const afterImage = { lastTurnWasImage: true, previousImagePrompt: 'a futuristic city at dusk' };

console.log('\n1) Plain-language generation requests (no command, no mode switch)');
[
  'Create an image of Krishna playing flute under a moonlit sky.',
  'Generate a picture of Shiva sitting in meditation.',
  'Create a futuristic city',
  'Generate a cartoon dog',
  'Make a logo',
  'Create a poster',
  'Generate an image of a student studying Java',
  'Draw a cat',
  'Render a watercolor landscape',
  'Design a poster for my DSA roadmap',
  'Illustrate a mountain village',
  'Visualize a robot engineer',
  'Make an illustration of a mountain sunset',
  'Paint a sunrise over the ocean',
  'Sketch a medieval castle',
  'Make me a wallpaper of a forest',
  'create an image of a red sports car',
  'generate a picture: a lighthouse in a storm',
].forEach((m) => check(`GENERATE "${m}"`, op(m), 'GENERATE'));

console.log('\n2) Image UNDERSTANDING is never routed to image generation');
[
  'Look at this image.',
  'What is wrong in this screenshot?',
  'What do you see?',
  'Explain this image',
  'Describe the picture',
  'What is in this image?',
  'Who is in the photo?',
  'What does this diagram show?',
].forEach((m) => check(`UNDERSTAND "${m}"`, op(m), 'UNDERSTAND'));

console.log('\n3) Image-to-image (a reference image is attached)');
check(
  'EDIT "Generate a picture based on this uploaded image."',
  op('Generate a picture based on this uploaded image.', { hasAttachedImages: true }),
  'EDIT'
);
check(
  'EDIT "Make a similar version using this photo"',
  op('Make a similar version using this photo', { hasAttachedImages: true }),
  'EDIT'
);

console.log('\n4) Ordinary text AI is never routed to image generation');
[
  'hi',
  'how are you?',
  'What is Java?',
  'Explain polymorphism.',
  'Give me DSA questions.',
  'Give me websites to learn Java.',
  'Analyze my resume.',
  'make it 20',
  'Give me 10 LeetCode problems',
  'Write a Java program to sort an array',
  'create a table of contents',
  'generate a report on Java',
  'I want to see how dependency injection works',
  'draw up a plan for my next month',
  'make a list of interview topics',
].forEach((m) => check(`TEXT "${m}"`, op(m), 'NONE'));
// "make a list ..." / "draw up a plan" must stay text even after an image exists.
check('TEXT "make a list of topics" after an image', op('make a list of topics', afterImage), 'NONE');
check('TEXT "draw up a plan for my week" after an image', op('draw up a plan for my week', afterImage), 'NONE');

console.log('\n5) Conversational follow-ups on the previous image');
const followUps = [
  'Make it more realistic.',
  'Make it at night',
  'Add flying cars',
  'Add flying cars and make it a night scene.',
  'make it look like a watercolor painting',
  'Turn it into a cartoon',
  'change the background to a beach',
  'More realistic please',
  'Now make it at night',
  'the background should be more dramatic',
];
followUps.forEach((m) => {
  const r = detectImageOperation({ message: m, ...afterImage });
  check(`FOLLOW-UP "${m}"`, r.operation === 'GENERATE' && r.isFollowUp === true ? 'GENERATE(follow-up)' : r.operation, 'GENERATE(follow-up)');
});
// A NEW image request after an image must NOT be merged into the old prompt.
check('NEW IMAGE "Draw a cat" after an image', op('Draw a cat', afterImage), 'GENERATE');
check(
  'NEW IMAGE "Generate a picture of a robot" after an image',
  op('Generate a picture of a robot', afterImage),
  'GENERATE'
);
const fresh = detectImageOperation({ message: 'Draw a cat', ...afterImage });
check('NEW IMAGE "Draw a cat" is not flagged as a follow-up', fresh.isFollowUp, false);
check(
  'TEXT "Now explain the symbolism." after an image',
  op('Now explain the symbolism.', afterImage),
  'NONE'
);
check('TEXT "Explain polymorphism." after an image', op('Explain polymorphism.', afterImage), 'NONE');

console.log('\n6) Follow-up subject keeps the user\'s own words');
const subjects = {
  'Make it at night': 'at night',
  'Add flying cars': 'with flying cars',
  'Make it more realistic.': 'more realistic',
};
Object.entries(subjects).forEach(([msg, expectedSubject]) => {
  const r = detectImageOperation({ message: msg, ...afterImage });
  check(`subject "${msg}"`, r.subject, expectedSubject);
});
const merged = detectImageOperation({ message: 'Add flying cars', ...afterImage });
check('follow-up keeps the previous subject', merged.subject.includes('flying cars'), true);

console.log('\n7) Prompt cleaning');
const { stripGenerationWrapper, buildFollowUpModification } = require('../services/imageIntent');
check(
  'stripGenerationWrapper removes only the wrapper',
  stripGenerationWrapper('Create an image of Krishna playing flute under a moonlit sky.'),
  'Krishna playing flute under a moonlit sky'
);
check(
  'stripGenerationWrapper keeps descriptive words',
  stripGenerationWrapper('Generate a beautiful digital painting of a mountain sunset'),
  'beautiful digital painting of a mountain sunset'
);
check('buildFollowUpModification "make it at night"', buildFollowUpModification('make it at night'), 'at night');
check(
  'buildFollowUpModification "make the background more dramatic"',
  buildFollowUpModification('make the background more dramatic'),
  'more dramatic background'
);

console.log('\n========================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);