/// <reference path="./types/index.d.ts" />

// Supplement the bundled API typings with the device field used by this app.
declare namespace WechatMiniprogram {
  interface Wx {
    getDeviceInfo(): { platform: string }
  }
}

interface IAppOption {
  globalData: {
    userInfo?: WechatMiniprogram.UserInfo,
    session?: import('../miniprogram/domain/types').SessionView,
  }
  userInfoReadyCallback?: WechatMiniprogram.GetUserInfoSuccessCallback,
}
