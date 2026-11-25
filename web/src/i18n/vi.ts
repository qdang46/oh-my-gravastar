/**
 * Vietnamese string bundle. Must cover every key in `en.ts` — `t()`
 * falls back to English for anything missing, so partial coverage is
 * safe but should be completed over time.
 */

import type { Strings } from './en.ts';

export const vi: Strings = {
  // Navigation
  'nav.home': 'Trang chủ',
  'nav.lighting': 'Đèn',
  'nav.keys': 'Phím',
  'nav.macros': 'Macro',
  'nav.device': 'Thiết bị',
  'nav.performance': 'Hiệu năng',
  'nav.advanced': 'Nâng cao',
  'nav.music': 'Nhạc',
  'nav.diagnostics': 'Chẩn đoán',
  'nav.assistant': 'Trợ lý',

  // Shell chrome
  'app.name': 'oh-my-gravastar',
  'app.tagline': 'Cài đặt bàn phím GravaStar',
  'shell.connect': 'Kết nối',
  'shell.connectKeyboard': 'Kết nối bàn phím',
  'shell.disconnect': 'Ngắt kết nối',
  'shell.refresh': 'Làm mới',
  'shell.collapse': 'Thu gọn thanh bên',
  'shell.expand': 'Mở rộng thanh bên',
  'shell.menu': 'Menu',
  'shell.noDevice': 'Chưa có thiết bị',
  'shell.connectedDevice': 'Thiết bị đã kết nối',
  'shell.battery': 'Pin',
  'shell.musicBanner':
    'Đang ở chế độ nhạc — bàn phím sáng theo micro của bạn. ' +
    'Nhấn Dừng ở trang Nhạc để khôi phục đèn.',
  'shell.editBanner.text':
    'Đã kết nối — chỉ đọc. Bàn phím hoạt động để xem; mọi thay đổi ' +
    'đều tắt cho đến khi bạn cho phép trong phiên này.',
  'shell.editBanner.button': 'Bật chỉnh sửa',
  'shell.langLabel': 'Ngôn ngữ',

  // Connection phases
  'phase.disconnected': 'Chưa kết nối',
  'phase.picker-open': 'Chọn bàn phím…',
  'phase.connecting': 'Đang kết nối…',
  'phase.connected-read-only': 'Đã kết nối — chỉ đọc',
  'phase.editing-enabled': 'Đã bật chỉnh sửa',
  'phase.reconnect-read-only': 'Đã kết nối lại — chỉ đọc',
  'phase.device-busy-runtime': 'Đang ở chế độ nhạc',
  'phase.disconnected-mid-op': 'Mất kết nối giữa thao tác',
  'phase.write-uncertain': 'Chưa rõ kết quả — hãy làm mới trước',
  'phase.unsupported': 'Thiết bị không được hỗ trợ',
  'phase.hint.disconnected': 'Cắm bàn phím và nhấn Kết nối.',
  'phase.hint.picker-open': 'Chọn bàn phím trong cửa sổ trình duyệt.',
  'phase.hint.connecting': 'Đang mở bàn phím và đọc cài đặt…',
  'phase.hint.connected-read-only': 'Bạn có thể xem; thay đổi cần bật chỉnh sửa.',
  'phase.hint.editing-enabled': 'Những thay đổi bạn xác nhận sẽ được ghi và kiểm tra.',
  'phase.hint.reconnect-read-only':
    'Bàn phím vừa tự kết nối lại — nhấn "Bật chỉnh sửa" để cho phép thay đổi.',
  'phase.hint.device-busy-runtime': 'Hãy dừng chế độ nhạc trước khi thay đổi khác.',
  'phase.hint.disconnected-mid-op':
    'Bàn phím mất kết nối giữa thao tác — kết nối lại và làm mới trước khi thử lại.',
  'phase.hint.write-uncertain':
    'Một thay đổi có thể đã hoặc chưa được áp dụng — hãy làm mới bàn phím trước khi thử lại.',
  'phase.hint.unsupported': 'Ứng dụng này không cấu hình được thiết bị này.',

  // First-run / onboarding
  'onboard.title': 'Thiết lập bàn phím GravaStar của bạn',
  'onboard.intro':
    'Ứng dụng này giao tiếp trực tiếp với bàn phím qua trình duyệt — ' +
    'không cần trình điều khiển, không tài khoản, không gì rời khỏi máy tính của bạn.',
  'onboard.reqTitle': 'Trước khi bắt đầu',
  'onboard.req1': 'Dùng Chrome hoặc Edge trên máy tính Windows, Mac hoặc Linux.',
  'onboard.req2': 'Cắm bàn phím bằng cáp USB.',
  'onboard.req3': 'Đặt bàn phím gần cổng USB.',
  'onboard.stepConnect': 'Nhấn Kết nối và chọn bàn phím trong cửa sổ trình duyệt.',
  'onboard.stepIdentify': 'Chúng tôi nhận diện bàn phím theo tên và cho biết nó làm được gì.',
  'onboard.stepSafe': 'Mọi thay đổi đều cần bạn xác nhận — không có gì được ghi âm thầm.',
  'onboard.cta': 'Kết nối bàn phím',
  'onboard.busy': 'Đang xử lý…',

  // Confirmation surface
  'confirm.impact.title': 'Những gì sẽ thay đổi',
  'confirm.impact.affected': 'Phạm vi ảnh hưởng',
  'confirm.impact.persistent': 'Lưu trên bàn phím',
  'confirm.impact.backup': 'Sao lưu',
  'confirm.impact.rollback': 'Khả năng hoàn tác',
  'confirm.impact.restart': 'Khởi động lại / ngắt kết nối',
  'confirm.impact.persistentYes': 'Có — thay đổi được lưu trên bàn phím.',
  'confirm.impact.persistentNo': 'Không — chỉ ảnh hưởng phiên trình duyệt này.',
  'confirm.impact.backupYes': 'Đã chụp bản sao lưu cài đặt hiện tại trước đó.',
  'confirm.impact.backupNo': 'Chưa có bản sao lưu nào được chụp trước thay đổi này.',
  'confirm.impact.rollbackYes': 'Bạn có thể khôi phục cài đặt trước đó ở trang Sao lưu.',
  'confirm.impact.rollbackPartial': 'Chỉ một phần thay đổi này có thể hoàn tác tự động.',
  'confirm.impact.rollbackNo': 'Thay đổi này không thể tự động hoàn tác.',
  'confirm.impact.restartNone': 'Bàn phím vẫn hoạt động — không cần khởi động lại.',
  'confirm.impact.restartWarn': 'Bàn phím có thể khởi động lại hoặc ngắt kết nối trong giây lát.',

  // Status vocabulary
  'status.verified': 'Đã xác minh',
  'status.applied-unverified': 'Đã áp dụng — chưa xác minh',
  'status.partial': 'Áp dụng một phần',
  'status.unsupported': 'Không được hỗ trợ',
  'status.unverified': 'Chưa xác minh',
  'status.failed': 'Thất bại',
  'status.pending': 'Đang chờ',

  // Dashboard / Home
  'dash.title': 'Trang chủ',
  'dash.noDevice': 'Chưa kết nối bàn phím.',
  'dash.noDeviceHint':
    'Cắm bàn phím GravaStar bằng cáp USB, rồi nhấn Kết nối. Trang này ' +
    'cho biết bàn phím làm được gì, cài đặt hiện tại và lối tắt khi đã kết nối.',
  'dash.device': 'Thiết bị',
  'dash.model': 'Model',
  'dash.firmware': 'Firmware',
  'dash.battery': 'Pin',
  'dash.protocol': 'Giao thức',
  'dash.linkState': 'Trạng thái kết nối',
  'dash.linkReconnected': 'Đã kết nối lại — thay đổi bị chặn',
  'dash.linkConnected': 'Đã kết nối',
  'dash.profile': 'Cấu hình hiện tại',
  'dash.lighting': 'Đèn',
  'dash.speed': 'Tốc độ',
  'dash.brightness': 'Độ sáng',
  'dash.sleepTimer': 'Hẹn giờ ngủ',
  'dash.keyLayer': 'Tầng phím',
  'dash.savedProfile': 'Cấu hình đã lưu',
  'dash.profileHint1':
    'Các chỉnh sửa chưa lưu nằm trong từng trình chỉnh sửa (Phím, Đèn, Macro) ' +
    'và không được theo dõi ở đây — mở một mục để xem trạng thái.',
  'dash.profileHint2':
    'Cấu hình game/app đã đặt tên chỉ áp dụng thủ công ở trang Sao lưu — ' +
    'trình duyệt không thể tự phát hiện ứng dụng đang dùng.',
  'dash.quickActions': 'Thao tác nhanh',
  'dash.action.lighting': 'Đèn',
  'dash.action.lightingBlurb': 'Hiệu ứng, màu sắc, cảnh',
  'dash.action.keys': 'Phím',
  'dash.action.keysBlurb': 'Gán phím & tầng',
  'dash.action.macro': 'Macro',
  'dash.action.macroBlurb': 'Macro & thời gian',
  'dash.action.advanced': 'Nâng cao',
  'dash.action.advancedBlurb': 'SOCD / hẹn giờ / bật-tắt',
  'dash.action.music': 'Nhạc',
  'dash.action.musicBlurb': 'Đèn theo micro',
  'dash.action.device': 'Thiết bị',
  'dash.action.deviceBlurb': 'Chi tiết, sao lưu & khôi phục',
  'dash.action.assistant': 'Hỏi AI',
  'dash.action.assistantBlurb': 'Mô tả điều bạn muốn',
  'dash.action.backup': 'Sao lưu cài đặt',
  'dash.action.backupBlurb': 'Lưu điểm khôi phục',
  'dash.health': 'Sức khỏe thiết bị',
  'dash.featuresAvailable': 'Tính năng khả dụng',
  'dash.notSupported': 'Không hỗ trợ',
  'dash.unverified': 'Chưa xác minh',
  'dash.noWarnings': 'Không có cảnh báo — mọi thứ đã báo cáo đều đã xác minh hoặc như mong đợi.',
  'dash.readOnlyWarning':
    'Phiên này bắt đầu ở chế độ chỉ đọc — nhấn "Bật chỉnh sửa" trên thanh ' +
    'thông báo để cho phép thay đổi.',
  'dash.fnWarning': 'Kiểm tra tầng Fn',
  'dash.recentChanges': 'Thay đổi gần đây',
  'dash.noChanges': 'Chưa có thay đổi nào được ghi lại trong phiên này.',
  'dash.capabilities': 'Bàn phím của bạn làm được gì',
  'dash.capabilitiesHint':
    'Chỉ những tính năng thiết bị hỗ trợ mới hiện là dùng được; tính năng ' +
    'không có sẽ giải thích lý do.',
  'dash.backupNudge':
    'Mẹo: hãy sao lưu trước thay đổi đầu tiên — chỉ mất vài giây ở trang Sao lưu.',
  'dash.backupNudgeLink': 'Mở trang Sao lưu',

  // Common actions
  'common.cancel': 'Hủy',
  'common.confirm': 'Xác nhận',
  'common.close': 'Đóng',
  'common.ok': 'OK',
  'common.save': 'Lưu',
  'common.delete': 'Xóa',
  'common.back': 'Quay lại',
};
