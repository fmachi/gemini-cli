/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fsSync from 'node:fs';
import { ShellExecutionService } from './shellExecutionService.js';
import { NoopSandboxManager } from './sandboxManager.js';

const PTY_INTEGRATION_ENV_FLAG = 'GEMINI_PTY_INTEGRATION_TESTS';
const PTY_ITERATIONS = 64;
const PTY_BASELINE_FD_PROBE_COUNT = 4;

const shouldRun =
  process.env[PTY_INTEGRATION_ENV_FLAG] === '1' &&
  (os.platform() === 'darwin' || os.platform() === 'linux');

describe.runIf(shouldRun)(
  'ShellExecutionService PTY fd leak integration',
  () => {
    it('does not leak slave fds across rapid PTY executions', async () => {
      const getOpenPtyCount = (): number => {
        try {
          return fsSync.readdirSync('/dev/fd').filter((fdStr) => {
            try {
              const stat = fsSync.fstatSync(Number(fdStr));
              if (!stat.isCharacterDevice()) {
                return false;
              }
              const major = (stat.rdev >> 24) & 0xff;
              // On Darwin, major 15 is /dev/ptmx and 16 is /dev/ttys*
              return major === 15 || major === 16;
            } catch {
              return false;
            }
          }).length;
        } catch {
          return 0;
        }
      };

      const baselineSamples: number[] = [];
      for (let i = 0; i < PTY_BASELINE_FD_PROBE_COUNT; i++) {
        baselineSamples.push(getOpenPtyCount());
      }
      const baseline = Math.max(...baselineSamples);

      for (let i = 0; i < PTY_ITERATIONS; i++) {
        const handle = await ShellExecutionService.execute(
          'true',
          process.cwd(),
          () => {},
          new AbortController().signal,
          true,
          {
            sanitizationConfig: {
              enableEnvironmentVariableRedaction: false,
              allowedEnvironmentVariables: [],
              blockedEnvironmentVariables: [],
            },
            sandboxManager: new NoopSandboxManager(),
            sessionId: 'integration',
          },
        );
        await handle.result;
      }

      const finalCount = getOpenPtyCount();
      expect(finalCount - baseline).toBe(0);
    }, 120000);

    it('does not leak master ptmx descriptors across PTY executions', async () => {
      if (os.platform() !== 'darwin') {
        return;
      }

      const { spawnSync } = await import('node:child_process');
      const getPtmxCount = (): number => {
        try {
          return spawnSync(
            'lsof',
            ['-nP', '-a', '-p', String(process.pid), '/dev/ptmx'],
            { encoding: 'utf8' },
          )
            .stdout.split('\n')
            .filter((x: string) => x.includes('/dev/ptmx')).length;
        } catch {
          return 0;
        }
      };

      const baseline = getPtmxCount();

      for (let i = 0; i < 8; i++) {
        const handle = await ShellExecutionService.execute(
          'printf pty-probe',
          process.cwd(),
          () => {},
          new AbortController().signal,
          true,
          {
            sanitizationConfig: {
              enableEnvironmentVariableRedaction: false,
              allowedEnvironmentVariables: [],
              blockedEnvironmentVariables: [],
            },
            sandboxManager: new NoopSandboxManager(),
            sessionId: 'integration',
          },
        );
        await handle.result;
      }

      const finalCount = getPtmxCount();
      expect(finalCount - baseline).toBe(0);
    }, 60000);
  },
);
