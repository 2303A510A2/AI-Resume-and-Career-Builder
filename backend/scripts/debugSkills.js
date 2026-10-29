// Debug script: reproduce the sample resume + JD parse to inspect extracted skills.
const mongoose = require('mongoose');
require('dotenv').config();
const { parseResume } = require('../services/resumeParser');
const { parseJob } = require('../services/jobParser');
const { computeSkillGap } = require('../services/careerService');

const run = async () => {
  const sample = [
    'Jane Doe',
    'jane.doe@example.com | +1 555 010 4242 | linkedin.com/in/janedoe | github.com/janedoe',
    'Software Engineer with 4 years of experience building web applications.',
    'Technical Skills',
    'Java, Python, JavaScript, React, Node.js, MongoDB, SQL, Docker, Spring Boot, Git',
    'Education',
    "Bachelor of Technology in Computer Science, State University, 2021",
    'Projects',
    'Music Application - A full-stack music streaming app built with React, Node.js and MongoDB with JWT authentication and file uploads.',
    'NLP Project - Sentiment analysis classifier using Python and scikit-learn.',
    'Experience',
    'Software Engineer, Acme Corp (2021 - Present) - Built REST APIs and microservices with Java and Spring Boot.',
  ].join('\n');

  const { parsed } = await parseResume({ buffer: Buffer.from(sample), extension: 'txt' });
  console.log('\nResume parsed skills:', parsed.skills);

  const job = parseJob({
    jobTitle: 'Senior Java Developer',
    company: 'TechCorp',
    description: [
      'We are looking for a Senior Java Developer.',
      'Requirements:',
      '- Strong experience with Java, Spring Boot, SQL, REST APIs and Docker.',
      '- Experience with AWS and Kubernetes is a plus.',
      '- Bachelor degree in Computer Science required.',
      'Responsibilities:',
      '- Design and develop scalable microservices.',
      '- Write clean, testable code.',
    ].join('\n'),
  });
  console.log('\nJD required:', job.requiredSkills);
  console.log('JD preferred:', job.preferredSkills);
  console.log('JD responsibilities:', job.responsibilities);

  const gap = computeSkillGap({
    resumeSkills: parsed.skills,
    requiredSkills: job.requiredSkills,
    preferredSkills: job.preferredSkills,
  });
  console.log('\nGap matched:', gap.matched);
  console.log('Gap missing:', gap.missing);
  console.log('Gap matchPercent:', gap.matchPercent);
  await mongoose.disconnect();
};

run().catch((e) => { console.error(e); process.exit(1); });