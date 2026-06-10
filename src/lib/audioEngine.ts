// Audio Engine for AI Radio
// Handles: Lo-Fi Background Synthesizer generation, TTS decoding & playback queue, and dynamic ducking.

export interface ScriptSegment {
  speaker: "Aoede" | "Charon";
  text: string;
  emotion: string;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  bgmGain: GainNode | null = null;
  ttsGain: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  
  // State
  isPlaying: boolean = false;
  bgmVolume: number = 0.15;
  duckedBgmVolume: number = 0.03;
  ttsVolume: number = 1.0;
  
  // Sequencer properties
  private seqIntervalId: any = null;
  private currentBeat: number = 0;
  private bpm: number = 72;
  private lastScheduledTime: number = 0;
  
  // TTS Queue
  private ttsQueue: { segment: ScriptSegment; buffer: AudioBuffer }[] = [];
  private currentTtsSource: AudioBufferSourceNode | null = null;
  private onSegmentStart: ((segment: ScriptSegment) => void) | null = null;
  private onSegmentEnd: (() => void) | null = null;
  private onQueueEmpty: (() => void) | null = null;

  constructor() {
    // AudioContext will be initialized on user interaction
  }

  init() {
    if (this.ctx) return;
    
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass();
    
    // Create nodes
    this.bgmGain = this.ctx.createGain();
    this.ttsGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    
    this.bgmGain.gain.setValueAtTime(this.bgmVolume, this.ctx.currentTime);
    this.ttsGain.gain.setValueAtTime(this.ttsVolume, this.ctx.currentTime);
    
    // Analyser setup
    this.analyser.fftSize = 256;
    
    // Connections
    // BGM -> BgmGain -> Destination
    this.bgmGain.connect(this.ctx.destination);
    
    // TTS -> TtsGain -> Analyser -> Destination
    this.ttsGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  start() {
    this.init();
    if (!this.ctx) return;
    
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    
    this.isPlaying = true;
    this.startBgmSequencer();
    this.processTtsQueue();
  }

  stop() {
    this.isPlaying = false;
    this.stopBgmSequencer();
    this.stopTtsPlayback();
    
    if (this.ctx && this.ctx.state === "running") {
      this.ctx.suspend();
    }
  }

  setCallbacks(
    onStart: (segment: ScriptSegment) => void,
    onEnd: () => void,
    onEmpty: () => void
  ) {
    this.onSegmentStart = onStart;
    this.onSegmentEnd = onEnd;
    this.onQueueEmpty = onEmpty;
  }

  // --- Lo-Fi BGM Synthesizer Sequencer ---
  
  private startBgmSequencer() {
    if (!this.ctx) return;
    this.lastScheduledTime = this.ctx.currentTime;
    this.currentBeat = 0;
    
    const lookahead = 0.1; // schedule 100ms ahead
    const scheduleInterval = 50; // check every 50ms
    
    this.seqIntervalId = setInterval(() => {
      if (!this.ctx || !this.isPlaying) return;
      
      const currentTime = this.ctx.currentTime;
      const beatLength = 60 / this.bpm; // Time of one beat in seconds
      
      while (this.lastScheduledTime < currentTime + lookahead) {
        this.scheduleBeat(this.currentBeat, this.lastScheduledTime);
        this.lastScheduledTime += beatLength;
        this.currentBeat = (this.currentBeat + 1) % 16; // 16-step sequencer (4 bars)
      }
    }, scheduleInterval);
  }

  private stopBgmSequencer() {
    if (this.seqIntervalId) {
      clearInterval(this.seqIntervalId);
      this.seqIntervalId = null;
    }
  }

  // Chords definition
  // 1. FM7 (F3, A3, C4, E4)
  // 2. Em7 (E3, G3, B3, D4)
  // 3. Am7 (A3, C4, E4, G4)
  // 4. Dm7 (D3, F3, A3, C4)
  private chords = [
    [174.61, 220.00, 261.63, 329.63], // FM7 (F3, A3, C4, E4)
    [164.81, 196.00, 246.94, 293.66], // Em7 (E3, G3, B3, D4)
    [220.00, 261.63, 329.63, 392.00], // Am7 (A3, C4, E4, G4)
    [146.83, 174.61, 220.00, 261.63], // Dm7 (D3, F3, A3, C4)
  ];

  private scheduleBeat(beat: number, time: number) {
    if (!this.ctx || !this.bgmGain) return;
    
    const bar = Math.floor(beat / 4);
    const stepInBar = beat % 4;
    
    // Play Chord (Lofi Pad) on step 0 of each bar
    if (stepInBar === 0) {
      this.playChord(this.chords[bar], time, 3.0);
    }
    
    // Play Kick Drum on beat 0, 4, 8, 12
    if (beat % 4 === 0) {
      this.playLofiKick(time);
    }
    
    // Play Snare/Rim on beat 4, 12 (backbeat)
    if (beat % 8 === 4) {
      this.playLofiSnare(time);
    }

    // Play Hihat on steps 2, 6, 10, 14
    if (beat % 2 === 1) {
      this.playLofiHihat(time);
    }

    // Occasional melody note (Pentatonic scale based on chord)
    if (beat % 4 === 2 && Math.random() > 0.4) {
      const chord = this.chords[bar];
      const melodyNote = chord[Math.floor(Math.random() * chord.length)] * 2; // Octave up
      this.playMelodyNote(melodyNote, time);
    }
  }

  private playChord(frequencies: number[], time: number, duration: number) {
    if (!this.ctx || !this.bgmGain) return;
    
    const chordGain = this.ctx.createGain();
    chordGain.gain.setValueAtTime(0, time);
    chordGain.gain.linearRampToValueAtTime(0.04, time + 0.8); // Smooth slow attack
    chordGain.gain.setValueAtTime(0.04, time + duration - 0.8);
    chordGain.gain.exponentialRampToValueAtTime(0.0001, time + duration); // Slow release
    
    // Lowpass filter to make it Lofi / warm
    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(450, time);
    
    frequencies.forEach((freq) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      osc.type = "triangle"; // Warm triangular wave
      osc.frequency.setValueAtTime(freq, time);
      
      // Fine detune for chorus/warmth effect
      osc.detune.setValueAtTime((Math.random() - 0.5) * 15, time);
      
      osc.connect(chordGain);
      osc.start(time);
      osc.stop(time + duration);
    });
    
    chordGain.connect(lowpass);
    lowpass.connect(this.bgmGain);
  }

  private playLofiKick(time: number) {
    if (!this.ctx || !this.bgmGain) return;
    
    const kickGain = this.ctx.createGain();
    kickGain.gain.setValueAtTime(0.08, time);
    kickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);
    
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    // Frequency sweep from 110Hz down to 40Hz
    osc.frequency.setValueAtTime(110, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.15);
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(150, time);
    
    osc.connect(kickGain);
    kickGain.connect(filter);
    filter.connect(this.bgmGain);
    
    osc.start(time);
    osc.stop(time + 0.4);
  }

  private playLofiSnare(time: number) {
    if (!this.ctx || !this.bgmGain) return;
    
    // Snare using highpassed noise + sine pop
    const snareGain = this.ctx.createGain();
    snareGain.gain.setValueAtTime(0.03, time);
    snareGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
    
    // White noise buffer
    const bufferSize = this.ctx.sampleRate * 0.25;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = buffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1200, time);
    filter.Q.setValueAtTime(2, time);
    
    noiseSource.connect(filter);
    filter.connect(snareGain);
    snareGain.connect(this.bgmGain);
    
    noiseSource.start(time);
    noiseSource.stop(time + 0.25);
    
    // Add a small mid-range "snap"
    const snapOsc = this.ctx.createOscillator();
    snapOsc.type = "triangle";
    snapOsc.frequency.setValueAtTime(180, time);
    snapOsc.frequency.exponentialRampToValueAtTime(100, time + 0.05);
    
    const snapGain = this.ctx.createGain();
    snapGain.gain.setValueAtTime(0.03, time);
    snapGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    
    snapOsc.connect(snapGain);
    snapGain.connect(this.bgmGain);
    
    snapOsc.start(time);
    snapOsc.stop(time + 0.07);
  }

  private playLofiHihat(time: number) {
    if (!this.ctx || !this.bgmGain) return;
    
    const hatGain = this.ctx.createGain();
    hatGain.gain.setValueAtTime(0.012, time);
    hatGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    
    const bufferSize = this.ctx.sampleRate * 0.06;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(7000, time);
    
    noise.connect(filter);
    filter.connect(hatGain);
    hatGain.connect(this.bgmGain);
    
    noise.start(time);
    noise.stop(time + 0.06);
  }

  private playMelodyNote(freq: number, time: number) {
    if (!this.ctx || !this.bgmGain) return;
    
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.02, time + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.2);
    
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, time);
    
    // Add custom subtle delay effect to the melody to feel "lofi spacey"
    const delay = this.ctx.createDelay();
    delay.delayTime.setValueAtTime(0.3, time);
    
    const delayFeedback = this.ctx.createGain();
    delayFeedback.gain.setValueAtTime(0.4, time);
    
    // Delay routing
    osc.connect(gain);
    gain.connect(this.bgmGain); // Dry signal
    
    gain.connect(delay);
    delay.connect(delayFeedback);
    delayFeedback.connect(delay); // feedback loop
    delayFeedback.connect(this.bgmGain); // Wet signal
    
    osc.start(time);
    osc.stop(time + 1.5);
  }

  // --- TTS 音声生成・デコード・再生キュー ---

  queueSegment(segment: ScriptSegment, base64Audio: string) {
    if (!this.ctx) return;
    
    const buffer = this.decodePcm16(base64Audio);
    this.ttsQueue.push({ segment, buffer });
    
    // If playing and queue was empty, start processing immediately
    if (this.isPlaying && this.ttsQueue.length === 1 && !this.currentTtsSource) {
      this.processTtsQueue();
    }
  }

  // Decodes raw PCM16 (Little Endian, 24000Hz) Base64 into Web Audio AudioBuffer
  private decodePcm16(base64: string, sampleRate: number = 24000): AudioBuffer {
    if (!this.ctx) throw new Error("AudioContext is not initialized");
    
    const binary = window.atob(base64);
    const len = binary.length;
    const arrayBuffer = new ArrayBuffer(len);
    const bytes = new Uint8Array(arrayBuffer);
    
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
      // Normalize PCM16 (-32768 to 32767) to Float32 (-1.0 to 1.0)
      float32Array[i] = int16Array[i] / 32768.0;
    }
    
    const buffer = this.ctx.createBuffer(1, float32Array.length, sampleRate);
    buffer.copyToChannel(float32Array, 0);
    return buffer;
  }

  private processTtsQueue() {
    if (!this.isPlaying || !this.ctx || this.currentTtsSource) return;
    
    if (this.ttsQueue.length === 0) {
      if (this.onQueueEmpty) this.onQueueEmpty();
      return;
    }
    
    const { segment, buffer } = this.ttsQueue.shift()!;
    
    // Start Ducking BGM
    this.duckBgm(true);
    
    // Trigger callback
    if (this.onSegmentStart) this.onSegmentStart(segment);
    
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    
    source.connect(this.ttsGain!);
    
    source.onended = () => {
      this.currentTtsSource = null;
      
      // Unduck BGM
      this.duckBgm(false);
      
      // Trigger callback
      if (this.onSegmentEnd) this.onSegmentEnd();
      
      // Play next in queue
      setTimeout(() => {
        this.processTtsQueue();
      }, 500); // 500ms pause between segments for natural conversation feel
    };
    
    this.currentTtsSource = source;
    source.start();
  }

  private stopTtsPlayback() {
    if (this.currentTtsSource) {
      this.currentTtsSource.onended = null;
      try {
        this.currentTtsSource.stop();
      } catch (e) {}
      this.currentTtsSource = null;
    }
    this.ttsQueue = [];
    this.duckBgm(false);
  }

  // Smooth Gain Control (Ducking)
  private duckBgm(duck: boolean) {
    if (!this.ctx || !this.bgmGain) return;
    
    const time = this.ctx.currentTime;
    const targetVolume = duck ? this.duckedBgmVolume : this.bgmVolume;
    
    this.bgmGain.gain.cancelScheduledValues(time);
    // Smooth transition over 0.4 seconds
    this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, time);
    this.bgmGain.gain.linearRampToValueAtTime(targetVolume, time + 0.4);
  }
}

// Singleton helper to export a single instance
let globalAudioEngine: AudioEngine | null = null;
export const getAudioEngine = () => {
  if (typeof window === "undefined") return null;
  if (!globalAudioEngine) {
    globalAudioEngine = new AudioEngine();
  }
  return globalAudioEngine;
};
