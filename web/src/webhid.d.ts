/**
 * Minimal WebHID typings — the W3C spec is not yet in TypeScript's DOM lib.
 * Only the members this app uses are declared.
 */

interface HIDReportItem {
  isAbsolute: boolean;
  isArray: boolean;
  isRange: boolean;
  hasNull: boolean;
  hasPreferredState: boolean;
  wraps: boolean;
  usages: number[];
  usageMinimum: number;
  usageMaximum: number;
  designatorIndex: number;
  designatorMin: number;
  designatorMax: number;
  stringIndex: number;
  stringMinimum: number;
  stringMaximum: number;
  reportSize: number;
  reportCount: number;
  unitExponent: number;
  unit: number;
  unitSystem: HIDUnitSystem;
  reportId: number;
  isProtected: boolean;
}

type HIDUnitSystem = 'si' | 'si-linear' | 'english-linear' | 'custom' | 'time';

interface HIDReportInfo {
  reportId: number;
  items: HIDReportItem[];
}

interface HIDCollection {
  usagePage: number;
  usage: number;
  children: HIDCollection[];
  inputReports: HIDReportInfo[];
  outputReports: HIDReportInfo[];
  featureReports: HIDReportInfo[];
}

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
}

interface HIDDevice extends EventTarget {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  collections: HIDCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource | Uint8Array | number[]): Promise<void>;
  receiveFeatureReport(reportId: number, timeout?: number): Promise<DataView>;
}

interface HID {
  requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
  getDevices(): Promise<HIDDevice[]>;
}

interface Navigator {
  readonly hid: HID;
}
