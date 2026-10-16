import React, { Fragment } from 'react';
import { Component } from 'react';

import {
  AppDisplaySettingsTab,
  EditorScreen,
  FieldsTab,
  FieldRow,
  FieldLabel,
  FieldControl,
  GamepadWhiteImage,
  TelevisionWhiteImage,
  KeyboardWhiteImage,
  BlurImage,
  ShaderSettingsTab,
  WebrcadeContext,
} from '@webrcade/app-common';
import { DiskSelect } from './diskselect';
import { VkTransparencySelect } from './vktransparencyselect';

export class Apple2SettingsEditor extends Component {
  constructor() {
    super();
    this.state = {
      tabIndex: null,
      focusGridComps: null,
      values: {},
    };
    this.busy = false;
  }

  componentDidMount() {
    const { emulator } = this.props;

    const values = {
      origBilinearMode: emulator.getPrefs().getBilinearMode(),
      bilinearMode: emulator.getPrefs().getBilinearMode(),
      origScreenSize: emulator.getPrefs().getScreenSize(),
      screenSize: emulator.getPrefs().getScreenSize(),
      origScreenControls: emulator.getPrefs().getScreenControls(),
      screenControls: emulator.getPrefs().getScreenControls(),
      origVkTransparency: emulator.getPrefs().getVkTransparency(),
      vkTransparency: emulator.getPrefs().getVkTransparency(),
      origMediaIndex: emulator.getMediaIndex(),
      mediaIndex: emulator.getMediaIndex(),
      origFlop2Index: emulator.getFlop2Index(),
      flop2Index: emulator.getFlop2Index(),
    };

    this.shaderService = emulator.getShadersService();
    this.shaderService.addEditorValues(values);

    this.setState({ values });
  }

  render() {
    const { emulator, onClose, showOnScreenControls } = this.props;
    const { tabIndex, values, focusGridComps } = this.state;

    const setFocusGridComps = (comps) => this.setState({ focusGridComps: comps });
    const setValues = (values) => this.setState({ values: values });

    const driveCollision = values.mediaIndex !== -1 && values.mediaIndex === values.flop2Index;

    return (
      <EditorScreen
        showCancel={true}
        okDisabled={driveCollision}
        onOk={async () => {
          if (this.busy || driveCollision) return;

          this.busy = true;

          let change = false;
          if (values.origBilinearMode !== values.bilinearMode) {
            emulator.getPrefs().setBilinearMode(values.bilinearMode);
            change = true;
          }
          if (values.origScreenSize !== values.screenSize) {
            emulator.getPrefs().setScreenSize(values.screenSize);
            emulator.updateScreenSize();
            change = true;
          }
          if (values.origScreenControls !== values.screenControls) {
            emulator.getPrefs().setScreenControls(values.screenControls);
            emulator.updateOnScreenControls();
            change = true;
          }
          if (values.origVkTransparency !== values.vkTransparency) {
            emulator.getPrefs().setVkTransparency(values.vkTransparency);
            emulator.updateVkTransparency();
            change = true;
          }
          if (change) emulator.getPrefs().save();

          const newMediaIndex = parseInt(values.mediaIndex);
          if (values.origMediaIndex !== newMediaIndex) {
            emulator.setMediaIndex(newMediaIndex, true);
          }
          const newFlop2Index = parseInt(values.flop2Index);
          if (values.origFlop2Index !== newFlop2Index) {
            emulator.setFlop2Index(newFlop2Index, true);
          }

          await this.shaderService.setShader(values.shaderId);
          emulator.updateBilinearFilter();

          onClose();
        }}
        onClose={onClose}
        focusGridComps={focusGridComps}
        onTabChange={(oldTab, newTab) => this.setState({ tabIndex: newTab })}
        tabs={(() => {
          const hasSession = emulator.getMediaList().length > 1;
          const o = hasSession ? 1 : 0;
          return [
            ...(hasSession ? [{
              image: GamepadWhiteImage,
              label: 'Apple II Settings (Session only)',
              content: (
                <Apple2SessionSettingsTab
                  emulator={emulator}
                  isActive={tabIndex === 0}
                  setFocusGridComps={setFocusGridComps}
                  values={values}
                  setValues={setValues}
                />
              ),
            }] : []),
            {
              image: TelevisionWhiteImage,
              label: 'Display Settings',
              content: (
                <AppDisplaySettingsTab
                  emulator={emulator}
                  isBilinearMode={true}
                  isActive={tabIndex === o}
                  showOnScreenControls={showOnScreenControls}
                  setFocusGridComps={setFocusGridComps}
                  values={values}
                  setValues={setValues}
                />
              ),
            },
            {
              image: BlurImage,
              label: 'Shader Settings',
              content: (
                <ShaderSettingsTab
                  shaderService={this.shaderService}
                  emulator={emulator}
                  isActive={tabIndex === o + 1}
                  setFocusGridComps={setFocusGridComps}
                  values={values}
                  setValues={setValues}
                />
              ),
            },
            {
              image: KeyboardWhiteImage,
              label: 'Virtual Keyboard Settings',
              content: (
                <Apple2VirtualKeyboardTab
                  emulator={emulator}
                  isActive={tabIndex === o + 2}
                  setFocusGridComps={setFocusGridComps}
                  values={values}
                  setValues={setValues}
                />
              ),
            },
          ];
        })()}
      />
    );
  }
}

class Apple2SessionSettingsTab extends FieldsTab {
  constructor(props) {
    super(props);
    this.mediaRef = React.createRef();
    this.flop2Ref = React.createRef();
    this.mediaList = props.emulator.getMediaList();
    const enable2nd525 = props.emulator.getProps().enable2nd525 || false;
    this.gridComps = [];

    if (this.mediaList && this.mediaList.length > 1) {
      this.gridComps.push([this.mediaRef]);
    }
    // Show drive 2 selector only if enabled AND there are 2+ disks
    if (enable2nd525 && this.mediaList && this.mediaList.length > 1) {
      this.gridComps.push([this.flop2Ref]);
    }
  }

  componentDidUpdate(prevProps, prevState) {
    const { gridComps } = this;
    const { setFocusGridComps, isActive } = this.props;
    if (isActive && isActive !== prevProps.isActive) {
      setFocusGridComps(gridComps);
    }
  }

  render() {
    const { mediaRef, flop2Ref, mediaList } = this;
    const { focusGrid } = this.context;
    const { setValues, values, emulator } = this.props;

    const enable2nd525 = emulator.getProps().enable2nd525 || false;

    // Build a stable options list — same order/length no matter what the
    // other drive is set to, so switching one drive never visually
    // reshuffles the other's selector. Both drives may momentarily point
    // at the same disk while the user is choosing; that's flagged below
    // and blocked on OK rather than "resolved" by silently ejecting one.
    const getOptions = () => {
      const opts = [{ value: -1, label: "(none)" }];
      for (let i = 0; i < mediaList.length; i++) {
        opts.push({ value: i, label: (i + 1) + ": " + mediaList[i].shortName });
      }
      return opts;
    };

    return (
      <>
        {mediaList && mediaList.length > 1 && (
          <FieldRow>
            <FieldLabel>{enable2nd525 ? "Disk Drive 1" : "Current Disk"}</FieldLabel>
            <FieldControl>
              <DiskSelect
                selectRef={mediaRef}
                mediaList={mediaList}
                customOptions={enable2nd525 ? getOptions() : null}
                onChange={(value) => {
                  setValues({ ...values, mediaIndex: value });
                }}
                value={values.mediaIndex}
                onPad={e => focusGrid.moveFocus(e.type, mediaRef)}
              />
            </FieldControl>
          </FieldRow>
        )}
        {enable2nd525 && mediaList && mediaList.length > 1 && (
          <FieldRow>
            <FieldLabel>Disk Drive 2</FieldLabel>
            <FieldControl>
              <DiskSelect
                selectRef={flop2Ref}
                mediaList={mediaList}
                customOptions={getOptions()}
                onChange={(value) => {
                  setValues({ ...values, flop2Index: value });
                }}
                value={values.flop2Index}
                onPad={e => focusGrid.moveFocus(e.type, flop2Ref)}
              />
            </FieldControl>
          </FieldRow>
        )}
        {enable2nd525 && values.mediaIndex !== -1 && values.mediaIndex === values.flop2Index && (
          <div style={{ textAlign: 'center', fontSize: '1.1rem', color: '#ff6b6b', padding: '0.75rem 0' }}>
            Drive 1 and Drive 2 can't contain the same disk.
          </div>
        )}
      </>
    );
  }
}
Apple2SessionSettingsTab.contextType = WebrcadeContext;

class Apple2VirtualKeyboardTab extends FieldsTab {
  constructor() {
    super();
    this.vkTransparencyRef = React.createRef();
    this.gridComps = [
      [this.vkTransparencyRef],
    ];
  }

  componentDidUpdate(prevProps, prevState) {
    const { gridComps } = this;
    const { setFocusGridComps, isActive } = this.props;
    if (isActive && isActive !== prevProps.isActive) {
      setFocusGridComps(gridComps);
    }
  }

  render() {
    const { vkTransparencyRef } = this;
    const { focusGrid } = this.context;
    const { setValues, values } = this.props;

    return (
      <Fragment>
        <FieldRow>
          <FieldLabel>Transparency</FieldLabel>
          <FieldControl>
            <VkTransparencySelect
              selectRef={vkTransparencyRef}
              onChange={(value) => {
                setValues({ ...values, ...{ vkTransparency: value } });
              }}
              value={values.vkTransparency}
              onPad={e => focusGrid.moveFocus(e.type, vkTransparencyRef)}
            />
          </FieldControl>
        </FieldRow>
      </Fragment>
    );
  }
}
Apple2VirtualKeyboardTab.contextType = WebrcadeContext;
