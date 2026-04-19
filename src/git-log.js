import { execSync } from 'child_process';
const history = execSync('git log -p src/lib/processor.ts').toString();
console.log(history.substring(0, 3000));
