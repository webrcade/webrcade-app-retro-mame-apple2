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
import { createEmptyDisk525 } from './emptydisk';

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
    this.flop2Index = -1; // -1 = no disk mounted
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
    // WRC - LTRIG+RANALOG opens the virtual keyboard, via the shared
    // CIDS.WRC_CUSTOM synthetic control (see its own comment in
    // @webrcade/app-common/src/input/controls.js) rather than the old
    // handleEscape()/CIDS.ESCAPE interception (removed) - that combo
    // stopped synthesizing CIDS.ESCAPE, so this app now uses the control
    // reserved to replace it instead.
    if (!this.paused) {
      if (controllers.isControlDown(0, CIDS.WRC_CUSTOM)) {
        if (!this.gamepadVkPending) {
          this.gamepadVkPending = true;
          controllers
            .waitUntilControlReleased(0, CIDS.WRC_CUSTOM)
              .then(() => {
                this.gamepadVkPending = false;
                this.toggleKeyboard();
              });
        }
      } else if (controllers.isControlDown(0, CIDS.SELECT)) {
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

  async applyGameSettings() {
    if (this.getProps().initialKeyboardMode === 1) {
      this.keyboardJoystickMode = false;
    }
  }

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
  getFlop2Index() { return this.flop2Index; }

  getMediaPath() {
    return this.mediaList.length > 0 && this.mediaIndex >= 0 ? this.mediaList[this.mediaIndex].path : '';
  }

  getFlop2Path() {
    return this.mediaList.length > 0 && this.flop2Index >= 0 ? this.mediaList[this.flop2Index].path : '';
  }

  setMediaIndex(index, eject = false) {
    const { Module } = window;
    this.mediaIndex = index;

    if (eject) {
      Module._wrc_set_options(this.OPT12);
    }
  }

  setFlop2Index(index, eject = false) {
    this.flop2Index = index;
    // OPT12 handles all drives
    if (eject) {
      window.Module._wrc_set_options(this.OPT12);
    }
  }

  updateSaveStateForSlotProps(slot, props) {
    props.stateName = this.getMediaList()[this.getMediaIndex()].stateName;
    props.flop2StateName = this.mediaList.length > 0 && this.flop2Index >= 0
      ? this.mediaList[this.flop2Index].stateName : null;
  }

  async loadStateForSlot(slot, currentSlot) {
    const stateName = currentSlot.stateName;
    if (stateName) {
      const mediaList = this.getMediaList();
      let found = false;
      for (let i = 0; i < mediaList.length; i++) {
        const media = mediaList[i];
        if (media.stateName === stateName) {
          this.setMediaIndex(i, true);
          found = true;
          break;
        }
      }
      if (!found) this.setMediaIndex(-1, true);
    } else {
      // Drive 1 was empty ("none") when this state was saved -- eject
      // whatever's currently mounted rather than leaving it in place.
      this.setMediaIndex(-1, true);
    }

    const enable2nd525 = this.getProps().enable2nd525 || false;
    const flop2StateName = currentSlot.flop2StateName;
    if (enable2nd525 && flop2StateName) {
      let found = false;
      for (let i = 0; i < this.mediaList.length; i++) {
        if (this.mediaList[i].stateName === flop2StateName) {
          this.setFlop2Index(i, true);
          found = true;
          break;
        }
      }
      if (!found) this.setFlop2Index(-1, true);
    } else {
      // Not enabled, or enabled but empty ("none") when saved -- eject either way.
      this.setFlop2Index(-1, true);
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
        "up":    this.INP_UP,
        "down":  this.INP_DOWN,
        "left":  this.INP_LEFT,
        "right": this.INP_RIGHT,
      };

      this.moveBits = {
        "moveup":    this.INP_UP,
        "movedown":  this.INP_DOWN,
        "moveleft":  this.INP_LEFT,
        "moveright": this.INP_RIGHT,
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

      this.mappings = { ...this.getMappings() };
      const DPAD_DEFAULTS = { up: 'moveup', down: 'movedown', left: 'moveleft', right: 'moveright' };
      for (const [btn, defaultAction] of Object.entries(DPAD_DEFAULTS)) {
        if (this.mappings[btn] === undefined) {
          this.mappings[btn] = defaultAction;
        }
      }
    }
  }

  sendInput(controller, input, analog0x, analog0y, analog1x, analog1y) {
    if (controller !== 0) return;

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

    maskedInput &= ~(this.INP_A | this.INP_B | this.INP_UP | this.INP_DOWN | this.INP_LEFT | this.INP_RIGHT);

    for (const [btn, action] of Object.entries(this.mappings)) {
      const bit = this.buttonBits[btn];

      const isDown = !!(input & bit);
      if (isDown && (action === 'button0')) {
        maskedInput |= this.INP_A;
        continue;
      }
      if (isDown && (action === 'button1')) {
        maskedInput |= this.INP_B;
        continue;
      }

      const moveBit = this.moveBits[action];
      if (moveBit) {
        if (isDown) maskedInput |= moveBit;
        continue;
      }

      const keyDef = this.keyActions[action];
      if (bit && keyDef) {
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
    const realDiskCount = this.media.length;

    // Save disks: unconditional for Apple II (no format ambiguity, unlike
    // IIGS). Count is per drive TYPE, not per physical drive -- Apple II
    // only has one type (5.25"), so drive 1 and drive 2 share a single pool
    // of N blanks rather than each getting their own -- see
    // SAVE_DISKS_DESIGN.md.
    const enable2nd525 = this.getProps().enable2nd525 || false;
    // Explicit 0 ("none") must stay 0 -- a truthy check would treat it the
    // same as undefined and silently fall back to 1.
    const totalSaveDisks = this.saveDisks === undefined ? 1 : this.saveDisks;

    LOG.info('[SaveDiskDebug] totalSaveDisks=' + totalSaveDisks +
      ' enable2nd525=' + enable2nd525);

    let saveDiskIndex = 0;

    for (let i = 0; i < (realDiskCount + totalSaveDisks); i++) {
      const isSaveDisk = i >= realDiskCount;
      const m = isSaveDisk ? null : this.media[i];
      const bytes = isSaveDisk ? createEmptyDisk525(++saveDiskIndex) : m[0];
      let name = isSaveDisk ? ('Save Disk ' + saveDiskIndex) : (m[1] || ('game' + i + '.dsk'));

      let updatedName, stateName;

      if (!isSaveDisk) {
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

        updatedName = updatedNameNoExt + (ext.length > 0 ? ('.' + ext) : '');
        stateName = updatedNameNoExt + '.state';
      } else {
        updatedName = 'savedisk' + saveDiskIndex + '.dsk';
        stateName = 'savedisk' + saveDiskIndex + '.state';
      }

      const currentMedia = {
        name: updatedName,
        md5: await this.getFileContentMd5(bytes),
        path: systemDir + updatedName,
        stateName: stateName,
        statePath: '/home/web_user/retroarch/userdata/states/' + stateName,
        originalName: name,
        shortName: name,
        isSaveDisk: isSaveDisk,
      };

      this.mediaList.push(currentMedia);

      let stream = FS.open(currentMedia.path, 'a');
      FS.write(stream, bytes, 0, bytes.length, 0, true);
      FS.close(stream);

      LOG.info('[SaveDiskDebug] Wrote disk: ' + currentMedia.path +
        ' stateName=' + currentMedia.stateName + (isSaveDisk ? ' (save disk)' : ''));
    }

    // Boot command: mounts whatever is first in mediaList, real media or a
    // save disk (matches C64). A save-disks-only item still needs something
    // mounted in the drive to actually boot to and write to -- otherwise it
    // never gets touched, saveState() never sees a change, and no save is
    // ever persisted (see SAVE_DISKS_DESIGN.md).
    // RA names its own save-state file after whichever disk is in the
    // highest-numbered actively-mounted drive -- flop2 beats flop1 whenever
    // both are mounted (confirmed via live testing). This is decided once,
    // here, rather than inside setMediaIndex/setFlop2Index -- those get
    // called from several other places (disk swap, state restore) that have
    // no business re-deciding which drive RA considers primary.
    if (this.mediaList.length > 0) {
      this.game = 'apple2e -gameio joy -flop1 "' + this.mediaList[0].path + '"';
      this.setMediaIndex(0);
      this.setStateFilePath(this.mediaList[0].statePath);

      if (enable2nd525 && this.mediaList.length > 1) {
        this.game += ' -flop2 "' + this.mediaList[1].path + '"';
        this.flop2Index = 1;
        this.setStateFilePath(this.mediaList[1].statePath);
      }
    }

    const realDisks = this.mediaList.filter(m => !m.isSaveDisk);
    const shorts = computeShortNames(realDisks.map(m => m.originalName));
    for (let i = 0; i < realDisks.length; i++) {
      const dot = shorts[i].indexOf('.');
      realDisks[i].shortName = dot !== -1 ? shorts[i].substring(0, dot) : shorts[i];
    }

    LOG.info('[SaveDiskDebug] final mediaList: ' + this.mediaList.map(
      m => m.stateName + (m.isSaveDisk ? ' (save disk)' : '')).join(', '));
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
          this.onKeyboardEvent(e);
          if (this.isKeyboardJoystickMode() &&
            this.controllers.getController(0).getKeyCodeToControllerMapping().getKeyCodeToControlId()[e.code] !== undefined)
            return;
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
      LOG.info('[SaveDiskDebug] saveState() media=' +
        (media ? media.map(m => m.name + (m.isSaveDisk ? ' (save disk)' : '')).join(', ') : 'null'));
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
                LOG.info('[SaveDiskDebug] saveState() changed: ' + m.name + ' (md5 ' + m.md5 + ' -> ' + currentMd5 + ')');
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

      const saveStatePath = `${this.saveStatePrefix}${this.SAVE_NAME}`;
      LOG.info('[SaveDiskDebug] saveState() path=' + saveStatePath +
        ' changedFiles=' + files.map(f => f.name).join(', '));

      const hasChanges = await this.getSaveManager().checkFilesChanged(files);
      LOG.info('[SaveDiskDebug] saveState() hasChanges=' + hasChanges);
      if (hasChanges) {
        await this.getSaveManager().save(
          saveStatePath,
          files,
          this.saveMessageCallback,
        );
        LOG.info('[SaveDiskDebug] saveState() saved to ' + saveStatePath);
      }
    } catch (e) {
      LOG.error('Error persisting save state: ' + e);
    }
  }

  async loadState() {
    const { FS } = window;

    try {
      const saveName = `${this.SAVE_NAME}.zip`;
      const loadPath = `${this.saveStatePrefix}${saveName}`;

      LOG.info('[SaveDiskDebug] loadState() loading from path=' + loadPath);

      const files = await this.getSaveManager().load(
        loadPath,
        this.loadMessageCallback,
      );

      LOG.info('[SaveDiskDebug] loadState() files=' +
        (files === null ? 'null' : files === undefined ? 'undefined' :
          '[' + files.map(f => f.name).join(', ') + ']'));

      // Cache file hashes
      await this.getSaveManager().checkFilesChanged(files);

      LOG.info('[SaveDiskDebug] loadState() current mediaList=' +
        this.mediaList.map(m => m.name + (m.isSaveDisk ? ' (save disk)' : '')).join(', '));

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const mediaItem = this.mediaList.find(m => m.name === f.name);
        LOG.info('[SaveDiskDebug] loadState() file=' + f.name +
          ' matchedMedia=' + (mediaItem ? mediaItem.path : 'NOT FOUND') +
          ' hasContent=' + !!f.content);
        if (mediaItem && f.content) {
          FS.writeFile(mediaItem.path, f.content);
        }
      }
    } catch (e) {
      LOG.error('Error loading save state: ' + e);
    }
  }
}
