'use strict';

/**
 * agent.js — Agent implementations the harness can call.
 *
 * Two implementations:
 *
 *   - StubAgent       deterministic, no network. Used by the mini-suite
 *                     + CI. Returns the pre-recorded stub*-arm diff.
 *
 *   - AnthropicAgent  real Claude over the Messages API + tool use.
 *                     Implementation lives in `./anthropic-agent.js`.
 *                     Requires ANTHROPIC_API_KEY.
 *
 * Factory:
 *
 *   - opts.stub === true             → StubAgent (explicit override)
 *   - !process.env.ANTHROPIC_API_KEY → StubAgent (graceful CI degrade)
 *   - opts.taskSet !== 'verified'    → StubAgent (mini-suite stays stubbed)
 *   - otherwise                      → AnthropicAgent
 */

const STUB_MODEL_LABEL = 'stub:deterministic';
const DEFAULT_REAL_MODEL = 'claude-sonnet-4-20250514';

class StubAgent {
  constructor(arm) {
    if (arm !== 'control' && arm !== 'carto') {
      throw new Error(`StubAgent: arm must be 'control' or 'carto' (got '${arm}')`);
    }
    this.arm = arm;
  }
  // eslint-disable-next-line no-unused-vars
  async solve(task, _scratchDir) {
    const t0 = Date.now();
    const diff = this.arm === 'carto' ? task.stubCarto : task.stubControl;
    return {
      diff,
      elapsedMs: Date.now() - t0,
      toolCalls: 0,
      tokensUsed: 0,
      model: STUB_MODEL_LABEL,
    };
  }
}

/**
 * getAgent(arm, opts) → Agent
 *
 *   - Returns StubAgent when ANTHROPIC_API_KEY is unset OR
 *     opts.taskSet !== 'verified' OR opts.stub === true.
 *   - Returns AnthropicAgent (real-API runner) otherwise. The real
 *     agent module is loaded lazily so the harness doesn't pay its
 *     module-load cost on every stub run.
 */
function getAgent(arm, opts = {}) {
  const taskSet = opts.taskSet || 'sample';
  const forceStub = !!opts.stub || taskSet !== 'verified' || !process.env.ANTHROPIC_API_KEY;
  if (forceStub) return new StubAgent(arm);
  const { AnthropicAgent } = require('./anthropic-agent');
  return new AnthropicAgent(arm, opts);
}

module.exports = {
  getAgent,
  StubAgent,
  STUB_MODEL_LABEL,
  DEFAULT_REAL_MODEL,
};
