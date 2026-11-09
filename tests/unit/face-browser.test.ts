import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMediapipeNoise, mediapipeLog } from '../../src/infra/face-browser';

describe('MediaPipe の記録', () => {
  afterEach(() => vi.restoreAllMocks());

  it('glog の知らせ・警告と TensorFlow Lite の知らせだけを捨てる', () => {
    expect(isMediapipeNoise('W1109 15:00:35.900000 2191552 gl_context.cc:1135] OpenGL error checking is disabled')).toBe(true);
    expect(isMediapipeNoise('I1109 15:00:35.900000 2191552 face_detector_graph.cc:10] ready')).toBe(true);
    expect(isMediapipeNoise('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')).toBe(true);
    expect(isMediapipeNoise('E1109 15:00:35.900000 2191552 graph.cc:1] failed')).toBe(false);
    expect(isMediapipeNoise('ERROR: something')).toBe(false);
    expect(isMediapipeNoise('何かほかの記録')).toBe(false);
    expect(isMediapipeNoise(new Error('INFO: '))).toBe(false);
  });

  it('dbg に渡された記録は、捨てないものだけ console.warn に出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mediapipeLog('W1109 15:00:35.900000 2191552 gl_context.cc:1135] OpenGL error checking is disabled');
    mediapipeLog('E1109 15:00:35.900000 2191552 graph.cc:1] failed');
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['E1109 15:00:35.900000 2191552 graph.cc:1] failed']);
  });
});
