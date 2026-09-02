import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Script } from 'node:vm';

const source = await readFile(new URL('../gas/Code.gs', import.meta.url), 'utf8');
new Script(source, { filename: 'gas/Code.gs' });
