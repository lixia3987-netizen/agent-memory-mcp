#!/usr/bin/env node
import { main, reportFailure } from './cli/index.ts';

await main().catch(reportFailure);
