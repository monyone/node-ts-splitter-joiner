#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

import { TSPacket, TSPacketQueue } from 'arib-mpeg2ts-parser';
import { TSSection, TSSectionQueue, TSSectionPacketizer } from 'arib-mpeg2ts-parser';
import { TSPES, TSPESQueue } from 'arib-mpeg2ts-parser';

import { Command } from 'commander';

import JoinTransform from './join-transform'

const program = new Command();

program
  .option('-i, --input <path>', 'input movie/video mpegts path')
  .option('-m, --meta <path>', 'input meta mpegts path')
  .option('-o, --output <path>', 'output mpagts path')
  .option('-t, --target <path>', 'target pcr timing offset')

program.parse(process.argv);
const options = program.opts();

const video = options.input == null || options.input === 'pipe:0' || options.input === '-' ? process.stdin : fs.createReadStream(options.input);
const meta = options.meta == null ? Buffer.from([]) : fs.readFileSync(options.meta);
const output = options.output == null || options.output === 'pipe:1' || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);
const target = options.target == null ? 0 : Number.parseInt(options.target, 10);

const meta_queue = new TSPacketQueue();
meta_queue.push(meta);

video.pipe(new JoinTransform(meta_queue, [], target)).pipe(output);
