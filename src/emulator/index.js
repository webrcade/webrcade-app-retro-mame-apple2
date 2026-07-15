import {
  RetroAppWrapper,
  ScriptAudioProcessor,
  Controllers,
  Controller,
  DisplayLoop,
  SCREEN_CONTROLS,
  KCODES,
  CIDS,
  KeyCodeToControlMapping,
  blobToStr,
  computeShortNames,
  md5,
  LOG,
} from '@webrcade/app-common';

import { Prefs } from './prefs';

export class Apple2KeyCodeToControlMapping extends KeyCodeToControlMapping {
  constructor() {
    super({
      [KCODES.ARROW_UP]:    CIDS.UP,
      [KCODES.ARROW_DOWN]:  CIDS.DOWN,
      [KCODES.ARROW_RIGHT]: CIDS.RIGHT,
      [KCODES.ARROW_LEFT]:  CIDS.LEFT,
      [KCODES.Z]:           CIDS.A,
      [KCODES.X]:           CIDS.B,
    });
  }
}

export class Emulator extends RetroAppWrapper {

  SAVE_NAME = 'sav';

  constructor(app, debug = false) {
    super(app, debug);
    window.emulator = this;
    this.mediaList = [];
    this.mediaIndex = 0;
    this.firstFrame = true;
    this.prefs = new Prefs(this);
    this.touchEvent = false;
    this.mouseEvent = false;
    this.keyboardEvent = false;
    this.diskActivity = false;
    this.selectDown = false;
    this.analogMode = true;
    this.keyboardJoystickMode = true;

    // Audio processing
    this.audioStarted = 0;
    this.audioCarry = 0;

    // Audio callback from C++ (receives audio buffer from MAME via EM_ASM)
    this.audioCallback = (offset, length) => {
      // length = incoming frames (mono)
      // Overproduce at 48015Hz then reduce during playback to handle timing variability

      // ---- target frames this callback ----
      const exactFrames = 48015 / 60; // 800.25
      const framesWithCarry = exactFrames + this.audioCarry;
      const outFrames = Math.floor(framesWithCarry);
      this.audioCarry = framesWithCarry - outFrames;

      // ---- input samples (stereo interleaved) ----
      const inSamples = length << 1;
      const input = new Int16Array(
        window.Module.HEAP16.buffer,
        offset,
        inSamples
      );

      // ---- output buffer (stereo interleaved) ----
      const outSamples = outFrames << 1;
      const output = new Int16Array(outSamples);

      // ---- frame walking resampler (no timing drift) ----
      const step = length / outFrames;

      let srcFrame = 0;
      for (let i = 0; i < outFrames; i++) {
        const si = (srcFrame | 0) << 1;

        output[i * 2]     = input[si];
        output[i * 2 + 1] = input[si + 1];

        srcFrame += step;
      }

      this.audioProcessor.storeSoundCombinedInput(
        output,
        2,
        outSamples,
        0,
        32768
      );
    };
  }

  createControllers() {
    return new Controllers([
      new Controller(new Apple2KeyCodeToControlMapping()),
      new Controller(),
      new Controller(),
      new Controller(),
    ]);
  }

  isKeyboardJoystickMode() {
    return this.keyboardJoystickMode;
  }

  setKeyboardJoystickMode(val) {
    this.controllers.setKeyboardDisabled(!val);
    return this.keyboardJoystickMode = val;
  }

  getScriptUrl() {
    return 'js/apple2e_libretro.js';
  }

  getPrefs() {
    return this.prefs;
  }

  getRomPointer() {
    if (!this.media || this.mediaIndex >= this.media.length) return 0;

    try {
      const bytes = this.media[this.mediaIndex][0];
      if (!bytes || bytes.length === 0) return 0;

      const ptr = window.Module._malloc(bytes.length);
      if (!ptr) return 0;

      window.Module.HEAPU8.set(bytes, ptr);

      window.Module._wrc_rom_ptr = ptr;
      window.Module._wrc_rom_size = bytes.length;

      return ptr;
    } catch (e) {
      console.error('Error getting ROM pointer:', e);
      return 0;
    }
  }

  getRomPointerLength() {
    return window.Module._wrc_rom_size || 0;
  }

  isEscapeHackEnabled() {
    return false;
  }

  isKeyboardEvent() {
    return this.keyboardEvent;
  }

  onDiskActivity(active) {
    this.diskActivity = active !== 0;
    const led = document.getElementById('disk-led');
    if (!led) return;
    if (this.diskActivity) {
      led.classList.add('disk-led-active');
    } else {
      led.classList.remove('disk-led-active');
      led.style.opacity = '0.15';
    }
  }


  pollControls() {
    const { controllers } = this;
    super.pollControls();
    if (!this.paused) {
      if (controllers.isControlDown(0, CIDS.SELECT)) {
        if (this.selectDown) return;
        this.selectDown = true;
        controllers
          .waitUntilControlReleased(0, CIDS.SELECT)
            .then(() => {
              this.toggleKeyboard();
              this.selectDown = false;
            });
      }
    }
  }

  handleEscape(controllers) {
    if (controllers.isControlDown(0, CIDS.LTRIG) && controllers.isControlDown(0, CIDS.RANALOG)) {
      if (!this.gamepadVkPending) {
        this.gamepadVkPending = true;
        controllers
          .waitUntilControlReleased(0, CIDS.ESCAPE)
            .then(() => {
              this.gamepadVkPending = false;
              this.toggleKeyboard();
            });
      }
      return true;
    }
    return false;
  }

  onPause(p) {
    const { app } = this;
    if (p) {
      try {
        this.setDisableInput(false);
        app.setKeyboardShown(false);
      } catch (e) {}
    }
    super.onPause(p);
  }

  async applyGameSettings() {}

  createAudioProcessor() {
    return new ScriptAudioProcessor(
      2,
      48000,
      8192 + 4096,
      2048
    ).setDebug(this.debug);
  }

  createTouchListener() {}

  isForceAspectRatio() { return false; }
  getDefaultAspectRatio() { return 1.333; }
  getShotAspectRatio() { return this.getDefaultAspectRatio(); }

  resizeScreen(canvas) {
    this.canvas = canvas;
    this.updateScreenSize();
  }

  createDisplayLoop(debug) {
    return new DisplayLoop(60, true, debug, false, false);
  }

  getMediaList() { return this.mediaList; }
  getMediaIndex() { return this.mediaIndex; }

  getMediaPath() {
    return this.mediaList[this.mediaIndex].path;
  }

  // setMediaIndex(index, eject = false) {
  //   const { Module } = window;
  //   this.mediaIndex = index;
  //   if (eject) {
  //     Module._wrc_set_options(this.OPT12);
  //   }
  // }

  setMediaIndex(index, eject = false) {
    const { Module } = window;
    this.mediaIndex = index;
    const currentMedia = this.mediaList[this.mediaIndex];
    if (index === 0) {
      this.setStateFilePath(currentMedia.statePath);
    }

    if (eject) {
      Module._wrc_set_options(this.OPT12);
    }
  }

  updateSaveStateForSlotProps(slot, props) {
    props.stateName = this.getMediaList()[this.getMediaIndex()].stateName;
  }

  async loadStateForSlot(slot, currentSlot) {
    const stateName = currentSlot.stateName;
    if (stateName) {
      const mediaList = this.getMediaList();
      for (let i = 0; i < mediaList.length; i++) {
        const media = mediaList[i];
        if (media.stateName === stateName) {
          this.setMediaIndex(i, true);
        }
      }
    }
    return await super.loadStateForSlot(slot);
  }

  getMappings() {
    return this.app.mappings || {};
  }

  initMaps() {
    if (!this._initMaps) {
      this._initMaps = true;

      this.buttonBits = {
        "a":  this.INP_A,
        "b":  this.INP_B,
        "x":  this.INP_X,
        "y":  this.INP_Y,
        "lb": this.INP_LBUMP,
        "rb": this.INP_RBUMP,
        "lt": this.INP_LTRIG,
        "rt": this.INP_RTRIG,
        "start": this.INP_START,
      };

      this.buttonIsDown = {};
      for (const key in this.buttonBits) {
        this.buttonIsDown[key] = [false, false, false, false];
      }

      this.keyActions = {
        "return":      { code: 'Enter'       },
        "space":       { code: 'Space'       },
        "escape":      { code: 'Escape'      },
        "tab":         { code: 'Tab'         },
        "delete":      { code: 'Backspace'   },
        "openapple":   { code: 'AltLeft'     },
        "closedapple": { code: 'AltRight'    },
        "minus":       { code: 'Minus'       },
        "equal":       { code: 'Equal'       },
        "lbracket":    { code: 'BracketLeft' },
        "rbracket":    { code: 'BracketRight'},
        "backslash":   { code: 'Backslash'   },
        "semicolon":   { code: 'Semicolon'   },
        "quote":       { code: 'Quote'       },
        "backtick":    { code: 'Backquote'   },
        "comma":       { code: 'Comma'       },
        "period":      { code: 'Period'      },
        "slash":       { code: 'Slash'       },
      };
      for (let c = 0; c < 26; c++) {
        const ch = (c + 10).toString(36);
        this.keyActions[ch] = { code: 'Key' + ch.toUpperCase() };
      }
      for (let c = 0; c <= 9; c++) {
        this.keyActions['' + c] = { code: 'Digit' + c };
      }

      this.mappings = this.getMappings();
    }
  }

  sendInput(controller, input, analog0x, analog0y, analog1x, analog1y) {
    if (controller === 0) {
      // const DEADZONE = 0.15;
      // const dx = (analog0x > -DEADZONE && analog0x < DEADZONE) ? 0 : analog0x;
      // const dy = (analog0y > -DEADZONE && analog0y < DEADZONE) ? 0 : analog0y;
      // const sx = Math.max(-1, Math.min(1, dx * (4/3)));
      // const sy = Math.max(-1, Math.min(1, dy * (4/3)));
      // const px = Math.round((sx + 1) * 127.5);
      // const py = Math.round((sy + 1) * 127.5);
      // console.log(`[input] ax=${analog0x.toFixed(3)} ay=${analog0y.toFixed(3)} -> pdl0=${px} pdl1=${py}`);
    }

    this.initMaps();
    let maskedInput = input;

    for (const [btn, action] of Object.entries(this.mappings)) {
      const bit = this.buttonBits[btn];
      const keyDef = this.keyActions[action];
      if (bit && keyDef) {
        const isDown = !!(maskedInput & bit);
        const wasDown = this.buttonIsDown[btn][controller];
        if (isDown && !wasDown) {
          if (keyDef.shift) this.sendKeyDown('ShiftLeft');
          this.sendKeyDown(keyDef.code);
        } else if (!isDown && wasDown) {
          this.sendKeyUp(keyDef.code);
          if (keyDef.shift) this.sendKeyUp('ShiftLeft');
        }
        this.buttonIsDown[btn][controller] = isDown;
        maskedInput &= ~bit;
      }
    }

    super.sendInput(controller, maskedInput, analog0x, analog0y, analog1x, analog1y);
  }

  async getFileContentMd5(content) {
    if (!(content instanceof Blob)) {
      content = new Blob([content]);
    }
    return md5(await blobToStr(content));
  }

  toggleKeyboard() {
    const { app } = this;
    const show = !app.isKeyboardShown();
    this.setDisableInput(show);
    app.setKeyboardShown(show);
  }

  updateVkTransparency() {
    this.app.setKeyboardTransparency(this.prefs.getVkTransparency());
  }

  showTouchOverlay(show) {
    const to = document.getElementById("touch-overlay");
    if (to) {
      to.style.display = show ? 'block' : 'none';
    }
  }

  checkOnScreenControls() {
    const controls = this.prefs.getScreenControls();
    if (controls === SCREEN_CONTROLS.SC_AUTO) {
      setTimeout(() => {
        this.showTouchOverlay(true);
        this.app.forceRefresh();
      }, 0);
    }
  }

  onKeyboardEvent(e) {
    if (e.code && !this.keyboardEvent) {
      this.keyboardEvent = true;
      this.checkOnScreenControls();
    }
  }

  onTouchEvent() {
    if (!this.touchEvent) {
      this.touchEvent = true;
      this.checkOnScreenControls();
    }
  }

  onMouseEvent() {
    if (!this.mouseEvent) {
      this.mouseEvent = true;
      this.checkOnScreenControls();
    }
  }

  updateOnScreenControls(initial = false) {
    const controls = this.prefs.getScreenControls();
    if (controls === SCREEN_CONTROLS.SC_OFF) {
      this.showTouchOverlay(false);
    } else if (controls === SCREEN_CONTROLS.SC_ON) {
      this.showTouchOverlay(true);
    } else if (controls === SCREEN_CONTROLS.SC_AUTO) {
      if (!initial) {
        setTimeout(() => {
          this.showTouchOverlay(this.touchEvent || this.mouseEvent);
          this.app.forceRefresh();
        }, 0);
      }
    }
  }

  async onStoreMedia() {
    const { FS } = window;
    this.mediaList = [];

    const systemDir = this.RA_DIR + 'apple2e/';

    for (let i = 0; i < this.media.length; i++) {
      const m = this.media[i];
      const bytes = m[0];
      let name = m[1] || ('game' + i + '.dsk');
      const slashIdx = name.lastIndexOf('/');
      if (slashIdx !== -1) name = name.substring(slashIdx + 1);

      const extIdx = name.lastIndexOf('.');
      let fileName = '';
      let ext = '';
      if (extIdx !== -1) {
        fileName = name.substring(0, extIdx);
        ext = name.substring(extIdx + 1);
      }

      const pstartIdx = fileName.indexOf('(');
      const pendIdx = fileName.lastIndexOf(')');

      let parens = '';
      if (pstartIdx !== -1 && pendIdx !== -1) {
        parens = fileName.substring(pstartIdx, pendIdx + 1);
      }

      const updatedNameNoExt = 'game' + i +
        (parens.length > 0 ? (' ' + parens) : '') +
        (fileName.toLowerCase().indexOf('ntsc') !== -1 ? ' NTSC' : '') +
        (fileName.toLowerCase().indexOf('pal') !== -1 ? ' PAL' : '');

      const updatedName = updatedNameNoExt + (ext.length > 0 ? ('.' + ext) : '');
      const stateName = updatedNameNoExt + '.state';

      const currentMedia = {
        name: updatedName,
        md5: await this.getFileContentMd5(bytes),
        path: systemDir + updatedName,
        stateName: stateName,
        statePath: '/home/web_user/retroarch/userdata/states/' + stateName,
        originalName: name,
        shortName: name,
      };

      this.mediaList.push(currentMedia);

      if (i === 0) {
        this.game = 'apple2e -gameio joy -flop1 "' + currentMedia.path + '"';
        this.setMediaIndex(0);
      }

      let stream = FS.open(currentMedia.path, 'a');
      FS.write(stream, bytes, 0, bytes.length, 0, true);
      FS.close(stream);

      LOG.info('Wrote disk: ' + currentMedia.path);
    }

    const shorts = computeShortNames(this.mediaList.map(m => m.originalName));
    for (let i = 0; i < this.mediaList.length; i++) {
      const dot = shorts[i].indexOf('.');
      this.mediaList[i].shortName = dot !== -1 ? shorts[i].substring(0, dot) : shorts[i];
    }
  }

  async onWriteAdditionalFiles() {
    const { FS } = window;

    // Create system dir BEFORE super call — super calls onStoreMedia which writes into it
    try { FS.mkdir(this.RA_DIR + 'apple2e'); } catch (e) {}

    await super.onWriteAdditionalFiles();

    // Write all BIOS files to system/mame/bios/
    const biosBuffers = this.biosBuffers;
    LOG.info('biosBuffers keys: ' + (biosBuffers ? Object.keys(biosBuffers).join(', ') : 'null'));
    if (biosBuffers) {
      try { FS.mkdir('/home/web_user/retroarch/userdata/system/mame'); } catch (e) {}
      try { FS.mkdir('/home/web_user/retroarch/userdata/system/mame/bios'); } catch (e) {}
      for (const name of Object.keys(biosBuffers)) {
        try {
          FS.writeFile(
            '/home/web_user/retroarch/userdata/system/mame/bios/' + name,
            biosBuffers[name],
          );
          LOG.info('Wrote BIOS: ' + name);
        } catch (e) {
          LOG.error('Error writing BIOS ' + name + ': ' + e);
        }
      }
    }

    // MAME.opt
    const mameOpt =
      'mame_alternate_renderer = "disabled"\n' +
      'mame_altres = "640x480"\n' +
      'mame_auto_save = "disabled"\n' +
      'mame_boot_to_bios = "disabled"\n' +
      'mame_boot_to_osd = "disabled"\n' +
      'mame_cheats_enable = "disabled"\n' +
      'mame_joystick_deadzone = "0.15"\n' +
      'mame_joystick_saturation = "0.85"\n' +
      'mame_joystick_threshold = "0.30"\n' +
      'mame_media_type = "flop1"\n' +
      'mame_mouse_enable = "disabled"\n' +
      'mame_read_config = "disabled"\n' +
      'mame_rotation_mode = "libretro"\n' +
      'mame_saves = "game"\n' +
      'mame_softlists_enable = "disabled"\n' +
      'mame_thread_mode = "disabled"\n' +
      'mame_throttle = "disabled"\n' +
      'mame_write_config = "disabled"\n';

    try { FS.mkdir('/home/web_user/retroarch/userdata/config/MAME'); } catch (e) {}
    try {
      FS.writeFile('/home/web_user/retroarch/userdata/config/MAME/MAME.opt', mameOpt);
      LOG.info('Wrote MAME.opt');
    } catch (e) {
      LOG.error('Error writing MAME.opt: ' + e);
    }
  }

  onFrame() {
    // Start audio processor after a few frames
    if (this.audioStarted !== -1) {
      if (this.audioStarted > 1) {
        this.audioStarted = -1;
        this.audioProcessor.start();
      } else {
        this.audioStarted++;
      }
    }

    if (this.firstFrame) {
      this.firstFrame = false;

      this.setKeyboardJoystickMode(this.isKeyboardJoystickMode());

      setTimeout(() => {
        const onTouch = () => { this.onTouchEvent() };
        window.addEventListener("touchstart", onTouch);
        window.addEventListener("touchend", onTouch);
        window.addEventListener("touchcancel", onTouch);
        window.addEventListener("touchmove", onTouch);

        const onMouse = () => { this.onMouseEvent() };
        window.addEventListener("mousedown", onMouse);
        window.addEventListener("mouseup", onMouse);
        window.addEventListener("mousemove", onMouse);

        document.onkeydown = (e) => {
          if (this.paused || this.app.isKeyboardShown()) return;
          if (this.isKeyboardJoystickMode() &&
            this.controllers.getController(0).getKeyCodeToControllerMapping().getKeyCodeToControlId()[e.code] !== undefined)
            return;
          this.onKeyboardEvent(e);
          if (e.repeat !== undefined && e.repeat) return;
          const retrok = this._browserCodeToRetrok(e.code);
          if (retrok) {
            window.Module._wrc_on_key(retrok, 1);
            e.stopPropagation();
            e.preventDefault();
          }
        };

        document.onkeyup = (e) => {
          if (this.paused || this.app.isKeyboardShown()) return;
          if (this.isKeyboardJoystickMode() &&
            this.controllers.getController(0).getKeyCodeToControllerMapping().getKeyCodeToControlId()[e.code] !== undefined)
            return;
          const retrok = this._browserCodeToRetrok(e.code);
          if (retrok) {
            window.Module._wrc_on_key(retrok, 0);
            e.stopPropagation();
            e.preventDefault();
          }
        };

        this.app.showCanvas();
      }, 10);
    }
  }

  // Map browser KeyboardEvent.code to RETROK values (libretro.h)
  _browserCodeToRetrok(code) {
    const map = {
      'KeyA': 97,  'KeyB': 98,  'KeyC': 99,  'KeyD': 100, 'KeyE': 101,
      'KeyF': 102, 'KeyG': 103, 'KeyH': 104, 'KeyI': 105, 'KeyJ': 106,
      'KeyK': 107, 'KeyL': 108, 'KeyM': 109, 'KeyN': 110, 'KeyO': 111,
      'KeyP': 112, 'KeyQ': 113, 'KeyR': 114, 'KeyS': 115, 'KeyT': 116,
      'KeyU': 117, 'KeyV': 118, 'KeyW': 119, 'KeyX': 120, 'KeyY': 121,
      'KeyZ': 122,
      'Digit0': 48, 'Digit1': 49, 'Digit2': 50, 'Digit3': 51, 'Digit4': 52,
      'Digit5': 53, 'Digit6': 54, 'Digit7': 55, 'Digit8': 56, 'Digit9': 57,
      'Space': 32, 'Enter': 13, 'Backspace': 8, 'Escape': 27, 'Tab': 9,
      'Delete': 127, 'Insert': 277, 'Home': 278, 'End': 279,
      'PageUp': 280, 'PageDown': 281, 'CapsLock': 301,
      'ArrowUp': 273, 'ArrowDown': 274, 'ArrowRight': 275, 'ArrowLeft': 276,
      'F1': 282, 'F2': 283, 'F3': 284, 'F4': 285,
      'F5': 286, 'F6': 287, 'F7': 288, 'F8': 289,
      'F9': 290, 'F10': 291, 'F11': 292, 'F12': 293,
      'ShiftLeft': 304, 'ShiftRight': 303,
      'ControlLeft': 306, 'ControlRight': 305,
      'AltLeft': 308, 'AltRight': 307,
      'Minus': 45, 'Equal': 61,
      'BracketLeft': 91, 'BracketRight': 93,
      'Semicolon': 59, 'Quote': 39,
      'Comma': 44, 'Period': 46, 'Slash': 47, 'Backslash': 92,
      'Backquote': 96,
    };
    return map[code] || 0;
  }

  // Accept browser KeyboardEvent.code strings (same interface as DOS VK)
  sendKeyDown(code) {
    const retrok = this._browserCodeToRetrok(code);
    const { Module } = window;
    if (retrok && Module && Module._wrc_on_key) Module._wrc_on_key(retrok, 1);
  }

  sendKeyUp(code) {
    const retrok = this._browserCodeToRetrok(code);
    const { Module } = window;
    if (retrok && Module && Module._wrc_on_key) Module._wrc_on_key(retrok, 0);
  }

  async saveState() {
    const { FS } = window;
    const files = [];
    try {
      const media = this.getMediaList();
      if (!media) return;

      const currentIndex = this.mediaIndex;

      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        try {
          // Unmount/remount to flush commit_image to the FS file
          this.setMediaIndex(i, true);

          const path = m.path;
          const res = FS.analyzePath(path, true);
          if (res.exists) {
            const s = FS.readFile(path);
            if (s) {
              const currentMd5 = await this.getFileContentMd5(s);
              // Only add if the file is different than the original
              if (currentMd5 !== m.md5) {
                files.push({
                  name: m.name,
                  content: s,
                });
              }
            }
          }
        } catch (e) {
          LOG.error(e);
        }
      }

      // Restore the active disk
      this.setMediaIndex(currentIndex, true);

      const hasChanges = await this.getSaveManager().checkFilesChanged(files);
      if (hasChanges) {
        await this.getSaveManager().save(
          `${this.saveStatePrefix}${this.SAVE_NAME}`,
          files,
          this.saveMessageCallback,
        );
      }
    } catch (e) {
      LOG.error('Error persisting save state: ' + e);
    }
  }

  async loadState() {
    const { FS } = window;

    try {
      const saveName = `${this.SAVE_NAME}.zip`;

      const files = await this.getSaveManager().load(
        `${this.saveStatePrefix}${saveName}`,
        this.loadMessageCallback,
      );

      // Cache file hashes
      await this.getSaveManager().checkFilesChanged(files);

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const mediaItem = this.mediaList.find(m => m.name === f.name);
        if (mediaItem && f.content) {
          FS.writeFile(mediaItem.path, f.content);
        }
      }
    } catch (e) {
      LOG.error('Error loading save state: ' + e);
    }
  }
}
