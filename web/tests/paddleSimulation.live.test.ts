import { describe, it } from 'vitest';
import { runPaddleSimulation } from './helpers/paddleSimulation';

describe.skipIf(process.env.SIGMAROUND_RUN_PADDLE_SIMULATION !== 'true')('operator-only Paddle-generated staging simulation', () => {
  it('verifies target, delivers and replays through Paddle, then retries the same signed event concurrently', async () => {
    await runPaddleSimulation();
  }, 180000);
});
