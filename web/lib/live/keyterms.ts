/**
 * Words the transcriber should listen for harder: the role, the company, the candidate's name and the technologies in
 * the job description and résumé. Interview speech is full of product and tool names that sound alike ("Kafka",
 * "Kubernetes", "Hibernate"), and an accent makes them harder still; telling the transcriber what to expect helps.
 */
const TECH = [
  'Java', 'JavaScript', 'TypeScript', 'Python', 'C++', 'C#', 'Kotlin', 'Swift', 'Scala', 'Rust', 'PHP', 'SQL', 'MySQL', 'PostgreSQL', 'MongoDB', 'Redis',
  'Cassandra', 'DynamoDB', 'Oracle', 'Kafka', 'RabbitMQ', 'Docker', 'Kubernetes', 'Jenkins', 'Git', 'GitHub', 'GitLab', 'AWS', 'Azure', 'GCP', 'Terraform',
  'Ansible', 'Linux', 'React', 'Angular', 'Vue', 'Redux', 'Next.js', 'Node.js', 'Express', 'Spring Boot', 'Spring', 'Hibernate', 'JPA', 'Maven', 'Gradle',
  'Selenium', 'Cypress', 'Postman', 'JUnit', 'Mockito', 'TestNG', 'Cucumber', 'Appium', 'JMeter', 'REST', 'GraphQL', 'gRPC', 'microservices', 'CI/CD',
  'DevOps', 'Agile', 'Scrum', 'Jira', 'Hadoop', 'Spark', 'Airflow', 'Snowflake', 'Tableau', 'Power BI', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch', 'Django',
  'Flask', 'FastAPI', 'HTML', 'CSS', 'Tailwind', 'Bootstrap', 'jQuery', 'OAuth', 'JWT', 'Elasticsearch', 'Splunk', 'Grafana', 'Prometheus', 'Salesforce',
  'SAP', 'ServiceNow', 'Android', 'iOS', 'Flutter', 'React Native', 'Firebase', 'LangChain', 'OpenAI', 'NLP', 'JVM', 'ORM', 'OOP', 'API', 'JSON', 'XML',
  'Laravel', 'Ruby on Rails', 'multithreading', 'polymorphism', 'encapsulation', 'inheritance', 'abstraction', 'data structures', 'algorithms',
];
const PLAIN = /^[\p{L}\p{N}][\p{L}\p{N} .+#&'/-]{1,39}$/u;
const NOT_NAMES = new Set(['resume', 'curriculum', 'vitae', 'cv', 'profile', 'summary', 'objective', 'experience', 'education', 'skills', 'projects', 'contact']);
const NOT_PROPER = new Set([
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'present', 'english', 'hindi', 'telugu', 'tamil', 'kannada', 'bachelor', 'master', 'university', 'college',
  'institute', 'school', 'company', 'limited', 'private', 'technologies', 'solutions', 'services', 'systems', 'project', 'responsibilities', 'experience',
  'education', 'skills', 'summary', 'objective', 'developed', 'worked', 'working', 'using', 'with', 'team', 'role', 'designed', 'implemented',
]);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const count = (haystack: string, term: string): number => {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu');
  return haystack.match(pattern)?.length ?? 0;
};

export interface KeytermSource { role: string; company: string; jobDescription: string; resumeText: string; supporting?: Array<{ text: string }> }

/** At most 25 plain words, most useful first. */
export function extractKeyterms(source: KeytermSource, limit = 25): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (term: string): void => {
    const clean = term.replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (!PLAIN.test(clean) || seen.has(key) || ordered.length >= limit) return;
    seen.add(key); ordered.push(clean);
  };
  // The role and the company are what the interviewer says first.
  if (source.role && !/^assignment$/i.test(source.role)) add(source.role.slice(0, 40));
  // The candidate's name is usually the first line of a résumé; interviewers use it ("Hi Ravi").
  const first = source.resumeText.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  const words = first.split(/\s+/);
  if (words.length >= 1 && words.length <= 3 && words.every(word => /^[\p{Lu}][\p{L}'-]{1,19}$/u.test(word)) && !words.some(word => NOT_NAMES.has(word.toLowerCase()))) add(words.join(' '));
  if (source.company && !/^assignment$/i.test(source.company)) add(source.company.slice(0, 40));

  const texts = { job: source.jobDescription, role: source.role, resume: source.resumeText, extra: (source.supporting ?? []).map(item => item.text).join('\n') };
  const scored = TECH.map(term => {
    const job = count(texts.job, term), role = count(texts.role, term), resume = count(texts.resume, term), extra = count(texts.extra, term);
    return { term, score: job * 3 + role * 4 + resume * 2 + extra };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  for (const item of scored.slice(0, 16)) add(item.term);

  // Names of employers, products and places in the middle of a sentence ("worked at Globex in Pune").
  const body = `${texts.resume}\n${texts.job}`;
  const proper = new Map<string, number>();
  for (const line of body.split(/\r?\n/)) {
    const tokens = line.split(/[\s,;:()|]+/).filter(Boolean);
    tokens.forEach((raw, index) => {
      // The first word of a line or of a sentence is capitalised anyway; only words in the middle of one count.
      if (index === 0 || /[.!?]$/.test(tokens[index - 1])) return;
      const token = raw.replace(/[.!?]+$/, '');
      if (!/^[\p{Lu}][\p{Ll}]{3,19}$/u.test(token) || NOT_PROPER.has(token.toLowerCase())) return;
      if (TECH.some(term => term.toLowerCase().split(' ').includes(token.toLowerCase()))) return;
      // A word of a name already added ("Boot" of "Spring Boot", "Kumar" of "Ravi Kumar") adds nothing.
      if (ordered.some(term => term.toLowerCase().split(' ').includes(token.toLowerCase()))) return;
      proper.set(token, (proper.get(token) ?? 0) + 1);
    });
  }
  for (const [token] of [...proper].sort((a, b) => b[1] - a[1]).slice(0, 8)) add(token);
  return ordered;
}
