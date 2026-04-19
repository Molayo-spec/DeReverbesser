import fs from 'fs';
import { AudioEngine } from './lib/audioEngine';

async function run() {
  const engine = new AudioEngine();
  console.log('loaded engine');
}

run();
