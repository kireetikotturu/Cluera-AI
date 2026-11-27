import { describe, expect, it } from 'vitest';
import { IntentDetector } from '../src/main/interview/IntentDetector';

describe('IntentDetector', () => {
  const detector = new IntentDetector();
  it('ignores small talk', () => expect(detector.detect('Okay, great.').isAnswerNeeded).toBe(false));
  it('waits for an incomplete question', () => expect(detector.detect('Tell me about your experience with').isComplete).toBe(false));
  it('classifies technical questions', () => expect(detector.detect('How have you used React in production?').intent).toBe('TECHNICAL_QUESTION'));
  it('classifies behavioral questions', () => expect(detector.detect('Tell me about a time when you handled a difficult conflict.').intent).toBe('BEHAVIORAL_QUESTION'));
  it('detects multiple questions', () => expect(detector.detect('What did you build? And also how did you test it?').intent).toBe('MULTI_PART_QUESTION'));
  it('waits for an ellipsis-ended incomplete question', () => expect(detector.detect('Tell me about your experience with…').isComplete).toBe(false));
  it('extracts the real question after context', () => expect(detector.detect('MongoDB is important for us. Have you used MongoDB?').question).toBe('Have you used MongoDB?'));
  it('answers a spoken self-introduction and questions about the candidate\'s projects', () => {
    expect(detector.detect('Introduce yourself').isAnswerNeeded).toBe(true);
    expect(detector.detect('Can you introduce yourself please').isAnswerNeeded).toBe(true);
    expect(detector.detect('What are your favorite projects?').intent).toBe('EXPERIENCE_QUESTION');
  });
  it('classifies coding and system-design questions', () => {
    expect(detector.detect('Implement a function and explain its complexity?').intent).toBe('CODING_QUESTION');
    expect(detector.detect('How would you design a highly available distributed system?').intent).toBe('SYSTEM_DESIGN');
  });
  // Openers that Auto Answer used to skip, as the speech service writes them (often without a question mark).
  it.each([
    'Intro yourself!', 'Self introduction.', 'Your introduction please.', 'Please give your introduction.', 'Let\'s start with your introduction.',
    'Ride a Python program to reverse a list.', 'Answer the question on the screen.', 'Okay. Take one scenario and explain in detail.',
    'So explain me about object oriented concepts.', 'Define encapsulation.', 'Explain closures.', 'Why Java?',
    'First, tell us about your project.', 'Now, suppose you have a million users and the site is slow.',
    'I want you to explain your current project.', 'We would like to understand your last role.', 'My question is, what is a deadlock.',
    'Difference between abstract class and interface.', 'Okay so can you explain closures.', 'I have a question. Explain closures.',
    'Hi, good morning. Brief about your project.', 'Write a program for the Fibonacci series.',
    'Briefly explain polymorphism.', 'Brief introduction.', 'Good. Self introduction.', 'Start by explaining closures.',
    'Name three data structures.', 'Take me through your current project.', 'Let\'s talk about your last project.',
    'Given an array of integers, find the two numbers that add up to a target.',
    'Our system has a memory leak, explain how you would find it.', 'If a request times out, how will you retry it',
  ])('answers %s', (text) => {
    expect(detector.detect(text)).toMatchObject({ isAnswerNeeded: true, isComplete: true });
  });
  it.each([
    'Okay, great.', 'Thank you.', 'Good morning.', 'Take your time.', 'Give me a second.', 'Okay, one second.', 'Have a nice day.',
    'That\'s good.', 'Thanks for your introduction.', 'I am the hiring manager for this role.', 'We use React in our team.',
    'We write code for banks.', 'Our code which we ship is reviewed.', 'I want to tell you about our company.', 'Let me share my screen.',
    'Let me give you a short overview.', 'Tell me', 'Hmm okay.',
    'Okay, let\'s start.', 'Let\'s begin the interview.', 'Let\'s talk tomorrow.', 'We will start with a brief overview of our company.',
    'Answer looks good.', 'Take a moment.', 'Take a moment to think about it.', 'Nice self introduction.', 'Good, nice self introduction.',
    'Look at the code that I shared.', 'Name\'s Priya, I lead the team.', 'We work on payments, design reviews and on-call.',
    'We are a product company, design is important to us.',
  ])('does not answer %s', (text) => {
    expect(detector.detect(text).isAnswerNeeded).toBe(false);
  });
  it('answers a whole question ending with a preposition once the speaker has finished', () => {
    expect(detector.detect('Which projects have you worked on').isComplete).toBe(false);
    expect(detector.detect('Which projects have you worked on', { speakerFinished: true })).toMatchObject({ isComplete: true, isAnswerNeeded: true });
    expect(detector.detect('Can you tell me about', { speakerFinished: true }).isComplete).toBe(false);
  });
  it('keeps the asking sentence, not meeting talk after it', () => {
    expect(detector.detect('Explain closures. Take your time.').question).toBe('Explain closures.');
  });
  it('recognizes follow-ups and multi-part questions', () => {
    expect(detector.detect('And why did you choose that approach?').intent).toBe('FOLLOW_UP');
    expect(detector.detect('Can you explain authentication and how you secured the API?').intent).toBe('MULTI_PART_QUESTION');
  });
});
