// app.ts
import { stopBroadcast } from './services/broadcast'
import { backendConfig } from './config/backend'
App<IAppOption>({
  globalData: {},
  onHide() { stopBroadcast() },
  onLaunch() {
    if (backendConfig.mode === 'local') {
      console.info('Backend selected', { backend: 'local', baseUrl: backendConfig.local.baseUrl })
      return
    }
    if (!wx.cloud) {
      wx.showModal({ title: '基础库版本过低', content: '请升级微信后重新打开小程序。', showCancel: false })
      return
    }
    wx.cloud.init({
      env: 'cloudbase-d4g492e2k23210f3a',
      traceUser: true,
    })
  },
})
