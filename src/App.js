import React, { Fragment } from "react";

import { WebrcadeRetroApp } from '@webrcade/app-common';

import { Emulator } from './emulator';
import { EmulatorPauseScreen } from './pause';
import { VK_TRANSPARENCY } from "./emulator/prefs";
import { TouchOverlay } from "./touchoverlay";
import { Keyboard } from "./keyboard";

import './App.scss';

class App extends WebrcadeRetroApp {

  constructor() {
    super();
    this.state = {
      ...this.state,
      showKeyboard: false,
      kbTransparency: VK_TRANSPARENCY.HIGH,
    };
  }

  createEmulator(app, isDebug) {
    return new Emulator(app, isDebug);
  }

  isBiosRequired() {
    return true;
  }

  getBiosMap() {
    return {
      'e07ffce4500ffeac9750c427d8309d9b': 'a2diskiing.zip',
      'd96a5b4370d665300802970c35cf1b7f': 'apple2e.zip',
      '2b50e7c8a9f2b55ddd2ace9fecdd6a60': 'd2fdc.zip',
      'c835eab06842e3c1d6e2e7dc19289828': 'votrsc01.zip',
      'b784c07140810457f6244d267cbbbb72': 'votrsc01a.zip',
    };
  }

  getBiosUrls(appProps) {
    return appProps.apple2_bios ? appProps.apple2_bios : [];
  }

  isDiscBased() {
    return false;
  }

  isMediaBased() {
    return true;
  }

  isKeyboardShown() {
    return this.state.showKeyboard;
  }

  setKeyboardShown(value) {
    this.setState({ showKeyboard: value });
  }

  setKeyboardTransparency(value) {
    this.setState({ kbTransparency: value });
  }

  showCanvas() {
    this.setState({ showCanvas: true });
  }

  renderPauseScreen() {
    const { appProps, emulator } = this;
    return (
      <EmulatorPauseScreen
        emulator={emulator}
        appProps={appProps}
        closeCallback={() => this.resume()}
        exitCallback={() => this.exitFromPause()}
        isEditor={this.isEditor}
        isStandalone={this.isStandalone}
      />
    );
  }

  render() {
    const { showCanvas, showKeyboard, kbTransparency } = this.state;
    return (
      <Fragment>
        {super.render()}
        <TouchOverlay show={showCanvas} />
        <Keyboard
          show={showKeyboard}
          transparency={kbTransparency}
        />
      </Fragment>
    );
  }
}

export default App;
