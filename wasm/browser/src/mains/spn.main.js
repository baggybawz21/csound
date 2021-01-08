/*
    CsoundScriptProcessor.js

    Copyright (C) 2018 Steven Yi, Victor Lazzarini

    This file is part of Csound.

    The Csound Library is free software; you can redistribute it
    and/or modify it under the terms of the GNU Lesser General Public
    License as published by the Free Software Foundation; either
    version 2.1 of the License, or (at your option) any later version.

    Csound is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public
    License along with Csound; if not, write to the Free Software
    Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
    02110-1301 USA
*/

import libcsoundFactory from "@root/libcsound";
import loadWasm from "@root/module";
import MessagePortState from "@utils/message-port-state";
import { writeToFs, lsFs, llFs, readFromFs, rmrfFs } from "@root/filesystem";
import { isEmpty } from "ramda";
import { csoundApiRename, fetchPlugins, makeSingleThreadCallback } from "@root/utils";
import { messageEventHandler } from "./messages.main";

class ScriptProcessorNodeSingleThread {
  constructor({ audioContext, inputChannelCount = 1, outputChannelCount = 2 }) {
    this.audioContext = audioContext;
    this.onaudioprocess = this.onaudioprocess.bind(this);
    this.currentPlayState = undefined;
    this.start = this.start.bind(this);
    this.wasm = undefined;
    this.csoundInstance = undefined;
    this.csoundApi = undefined;
    this.exportApi = {};
    this.spn = audioContext.createScriptProcessor(0, inputChannelCount, outputChannelCount);
    this.spn.audioContext = audioContext;
    this.spn.inputChannelCount = inputChannelCount;
    this.spn.outputChannelCount = outputChannelCount;
    this.spn.onaudioprocess = this.onaudioprocess;
    this.node = this.spn;
    this.exportApi.getNode = async () => this.spn;
    this.sampleRate = audioContext.sampleRate;
    // this is the only actual single-thread usecase
    // so we get away with just forwarding it as if it's form
    // a message port
    this.messagePort = new MessagePortState();
    this.messagePort.post = (log) => messageEventHandler({ event: { data: { log } } });
    this.messagePort.broadcastPlayState = (playStateChange) => {
      this.currentPlayState = playStateChange;
    };
    this.messagePort.ready = true;

    // imports from original csound-wasm
    this.started = false;
  }

  async pause() {}

  async resume() {}

  async setMessageCallback() {}

  async start() {
    if (!this.csoundApi) {
      console.error("starting csound failed because csound instance wasn't created");
      return undefined;
    }

    if (this.currentPlayState !== "realtimePerformanceStarted") {
      const ksmps = this.csoundApi.csoundGetKsmps(this.csoundInstance);
      this.ksmps = ksmps;
      this.cnt = ksmps;

      this.nchnls = this.csoundApi.csoundGetNchnls(this.csoundInstance);
      this.nchnls_i = this.csoundApi.csoundGetNchnlsInput(this.csoundInstance);

      const outputPointer = this.csoundApi.csoundGetSpout(this.csoundInstance);
      this.csoundOutputBuffer = new Float64Array(
        this.wasm.exports.memory.buffer,
        outputPointer,
        ksmps * this.nchnls,
      );

      const inputPointer = this.csoundApi.csoundGetSpin(this.csoundInstance);
      this.csoundInputBuffer = new Float64Array(
        this.wasm.exports.memory.buffer,
        inputPointer,
        ksmps * this.nchnls_i,
      );
      this.zerodBFS = this.csoundApi.csoundGet0dBFS(this.csoundInstance);
      this.started = true;
    }
    // TODO FIRE THE EVENT
    this.currentPlayState = "realtimePerformanceStarted";
    return this.csoundApi.csoundStart(this.csoundInstance);
  }

  async initialize({ wasmDataURI, withPlugins, autoConnect }) {
    if (!this.plugins && withPlugins && !isEmpty(withPlugins)) {
      withPlugins = await fetchPlugins(withPlugins);
    }

    if (!this.wasm) {
      [this.wasm, this.wasmFs] = await loadWasm({
        wasmDataURI,
        withPlugins,
        messagePort: this.workerMessagePort,
      });
    }

    // libcsound
    const csoundApi = libcsoundFactory(this.wasm);
    this.csoundApi = csoundApi;
    const csoundInstance = await csoundApi.csoundCreate(0);
    this.csoundInstance = csoundInstance;

    if (autoConnect) {
      this.spn.connect(this.audioContext.destination);
    }

    this.resetCsound(false);

    // this.plugins.forEach((plugin) => {
    //   console.log(plugin);
    //   console.log("INSTANCE??", this.wasm.exports.memory, plugin.exports.memory);
    //   plugin.exports.wasm_init(csoundInstance);
    // });

    // csoundObj
    Object.keys(csoundApi).reduce((acc, apiName) => {
      const renamedApiName = csoundApiRename(apiName);
      acc[renamedApiName] = makeSingleThreadCallback(csoundInstance, csoundApi[apiName]);
      return acc;
    }, this.exportApi);

    this.exportApi.pause = this.pause.bind(this);
    this.exportApi.resume = this.resume.bind(this);
    this.exportApi.setMessageCallback = this.setMessageCallback.bind(this);
    this.exportApi.start = this.start.bind(this);
    this.exportApi.reset = () => this.resetCsound(true);
    this.exportApi.getAudioContext = async () => this.audioContext;
    this.exportApi.name = "Csound: ScriptProcessor Node, Single-threaded";

    // filesystem export
    this.exportApi.writeToFs = writeToFs(this.wasmFs);
    this.exportApi.lsFs = lsFs(this.wasmFs);
    this.exportApi.readFromFs = readFromFs(this.wasmFs);
    this.exportApi.rmrfFs = rmrfFs(this.wasmFs);

    return this.exportApi;
  }

  async resetCsound(callReset) {
    this.running = false;
    this.started = false;
    this.result = 0;

    let cs = this.csoundInstance;
    let libraryCsound = this.csoundApi;

    if (callReset) {
      libraryCsound.csoundReset(cs);
    }

    // FIXME:
    // libraryCsound.csoundSetMidiCallbacks(cs);
    libraryCsound.csoundSetOption(cs, "-odac");
    libraryCsound.csoundSetOption(cs, "-iadc");
    libraryCsound.csoundSetOption(cs, "--sample-rate=" + this.sampleRate);
    this.nchnls = -1;
    this.nchnls_i = -1;
    this.csoundOutputBuffer = null;
  }

  onaudioprocess(e) {
    if (
      this.csoundOutputBuffer === null ||
      this.currentPlayState !== "realtimePerformanceStarted"
    ) {
      const output = e.outputBuffer;
      const bufferLen = output.getChannelData(0).length;

      for (let i = 0; i < bufferLen; i++) {
        for (let channel = 0; channel < output.numberOfChannels; channel++) {
          const outputChannel = output.getChannelData(channel);
          outputChannel[i] = 0;
        }
      }
      return;
    }

    const input = e.inputBuffer;
    const output = e.outputBuffer;

    const bufferLen = output.getChannelData(0).length;

    let csOut = this.csoundOutputBuffer;
    let csIn = this.csoundInputBuffer;

    const ksmps = this.ksmps;
    const zerodBFS = this.zerodBFS;

    const nchnls = this.nchnls;
    const nchnls_i = this.nchnls_i;

    let cnt = this.cnt || 0;
    let result = this.result || 0;

    for (let i = 0; i < bufferLen; i++, cnt++) {
      if (cnt == ksmps && result == 0) {
        // if we need more samples from Csound
        result = this.csoundApi.csoundPerformKsmps(this.csoundInstance);
        cnt = 0;
        if (result != 0) {
          // this.running = false;
          // this.started = false;
          // this.firePlayStateChange();
          // TODO fire event
          this.currentPlayState = "realtimePerformanceEnded";
        }
      }

      /* Check if MEMGROWTH occured from csoundPerformKsmps or otherwise. If so,
      rest output ant input buffers to new pointer locations. */
      if (csOut.length === 0) {
        csOut = this.csoundOutputBuffer = new Float64Array(
          this.wasm.exports.memory.buffer,
          this.csoundApi.csoundGetSpout(this.csoundInstance),
          ksmps * nchnls,
        );
      }

      if (csIn.length === 0) {
        csIn = this.csoundInputBuffer = new Float64Array(
          this.wasm.exports.memory.buffer,
          this.csoundApi.csoundGetSpin(this.csoundInstance),
          ksmps * nchnls_i,
        );
      }

      // handle 1->1, 1->2, 2->1, 2->2 input channel count mixing and nchnls_i
      const inputChanMax = Math.min(this.nchnls_i, input.numberOfChannels);
      for (let channel = 0; channel < inputChanMax; channel++) {
        const inputChannel = input.getChannelData(channel);
        csIn[cnt * nchnls_i + channel] = inputChannel[i] * zerodBFS;
      }

      // Output Channel mixing matches behavior of:
      // https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API#Up-mixing_and_down-mixing

      // handle 1->1, 1->2, 2->1, 2->2 output channel count mixing and nchnls
      if (this.nchnls == output.numberOfChannels) {
        for (let channel = 0; channel < output.numberOfChannels; channel++) {
          const outputChannel = output.getChannelData(channel);
          if (result == 0) outputChannel[i] = csOut[cnt * nchnls + channel] / zerodBFS;
          else outputChannel[i] = 0;
        }
      } else if (this.nchnls == 2 && output.numberOfChannels == 1) {
        const outputChannel = output.getChannelData(0);
        if (result == 0) {
          const left = csOut[cnt * nchnls] / zerodBFS;
          const right = csOut[cnt * nchnls + 1] / zerodBFS;
          outputChannel[i] = 0.5 * (left + right);
        } else {
          outputChannel[i] = 0;
        }
      } else if (this.nchnls == 1 && output.numberOfChannels == 2) {
        const outChan0 = output.getChannelData(0);
        const outChan1 = output.getChannelData(1);

        if (result == 0) {
          const val = csOut[cnt * nchnls] / zerodBFS;
          outChan0[i] = val;
          outChan1[i] = val;
        } else {
          outChan0[i] = 0;
          outChan1[i] = 0;
        }
      } else {
        // FIXME: we do not support other cases at this time
      }

      // for (let channel = 0; channel < input.numberOfChannels; channel++) {
      //   const inputChannel = input.getChannelData(channel);
      //   csIn[cnt * nchnls_i + channel] = inputChannel[i] * zerodBFS;
      // }
      // for (let channel = 0; channel < output.numberOfChannels; channel++) {
      //   const outputChannel = output.getChannelData(channel);
      //   if (result == 0) outputChannel[i] = csOut[cnt * nchnls + channel] / zerodBFS;
      //   else outputChannel[i] = 0;
      // }
    }

    this.cnt = cnt;
    this.result = result;
  }
}

export default ScriptProcessorNodeSingleThread;
