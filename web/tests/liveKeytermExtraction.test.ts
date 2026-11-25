import { describe, expect, it } from 'vitest';
import { extractKeyterms } from '../lib/live/keyterms';
import { keyterm } from '../lib/accountRelay/protocol';

const resume = `Ravi Kumar
Backend engineer, Hyderabad.

Worked at Globex Technologies on payment services using Java, Spring Boot, Hibernate and Kafka. Deployed with Docker and Kubernetes on AWS.
Previously at Initech in Pune. Built REST APIs with PostgreSQL.`;
const job = 'We need a backend engineer with Java, Spring Boot and Kafka. Experience with Kubernetes and CI/CD pipelines in Agile teams.';

describe('words for the transcriber to listen for', () => {
  const terms = extractKeyterms({ role: 'Java developer', company: 'Acme', jobDescription: job, resumeText: resume });
  it('starts with the role, the candidate and the company, then the technologies the job and résumé stress', () => {
    expect(terms.slice(0, 3)).toEqual(['Java developer', 'Ravi Kumar', 'Acme']);
    for (const wanted of ['Spring Boot', 'Kafka', 'Kubernetes', 'Hibernate', 'Docker', 'PostgreSQL', 'CI/CD']) expect(terms).toContain(wanted);
  });
  it('adds names of employers and places from the résumé, but not ordinary capitalised words', () => {
    expect(terms).toEqual(expect.arrayContaining(['Globex', 'Initech', 'Pune']));
    for (const junk of ['Worked', 'Previously', 'Built', 'Deployed', 'Backend']) expect(terms).not.toContain(junk);
  });
  it('keeps at most 25 and every one is a plain word the relay accepts, with no repeats', () => {
    expect(terms.length).toBeLessThanOrEqual(25);
    for (const term of terms) expect(keyterm.safeParse(term).success).toBe(true);
    expect(new Set(terms.map(term => term.toLowerCase())).size).toBe(terms.length);
  });
  it('copes with nothing to go on, an assignment and odd input', () => {
    expect(extractKeyterms({ role: '', company: '', jobDescription: '', resumeText: '' })).toEqual([]);
    expect(extractKeyterms({ role: 'Assignment', company: 'Assignment', jobDescription: '', resumeText: '' })).toEqual([]);
    const odd = extractKeyterms({ role: 'x'.repeat(80), company: 'bad=name', jobDescription: '\u0000\n\n', resumeText: 'Resume\nSkills' });
    for (const term of odd) expect(keyterm.safeParse(term).success).toBe(true);
    expect(odd).not.toContain('Resume');
  });
  it('does not take a heading for the candidate name', () => {
    expect(extractKeyterms({ role: 'QA', company: '', jobDescription: '', resumeText: 'Curriculum Vitae\nTester with Selenium' })).not.toContain('Curriculum Vitae');
  });
});
