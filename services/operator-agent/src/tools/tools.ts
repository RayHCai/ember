import { ACT_TOOLS } from './act.js';
import { READ_TOOLS } from './read.js';
import type { Tool } from './registry.js';

export const TOOLS: Tool[] = [...READ_TOOLS, ...ACT_TOOLS];
