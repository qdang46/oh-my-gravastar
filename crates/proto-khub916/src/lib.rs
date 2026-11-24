//! GravaStar K1 / K98 series "916" protocol (Web HubX Pro, WebHID feature
//! reports).
//!
//! **Status: not yet reversed.** The vendor driver is a generic multi-brand
//! keyboard SDK; the HID engine lives in the obfuscated
//! `index-M8-m9qFR.js` chunk mirrored in `docs/research/khub-webapp/`.
//! Each model has a `password` auth token (K1 = `0x0300000001b4`) and
//! `protocolKey` `916` (wired) / `916_wireLess` (2.4 GHz dongle).
//!
//! **Safety:** nothing may be sent until the protocol is documented;
//! read-only-by-default applies and every command must be proven read-only
//! before implementation.
