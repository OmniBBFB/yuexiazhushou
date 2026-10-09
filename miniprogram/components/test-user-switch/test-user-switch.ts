import { showError } from '../../api/client'
import { switchTestIdentity } from '../../services/test-switch'
import { supportsVirtualUsers, virtualSlots, virtualUser, virtualUserLabel } from '../../services/virtual-users'

const slots = ['', ...virtualSlots]
Component({
  properties: { disabled: { type: Boolean, value: false } },
  data: { enabled: false, busy: false, label: '', selected: 0, alive: false,
    options: slots.map(slot => slot === '' ? '真实微信账号' : slot === 'host' ? '虚拟房主（创建房间后才是房主）' : `虚拟玩家 ${slot.slice(7)}`) },
  lifetimes: { attached() { this.data.alive = true; this.refresh() }, detached() { this.data.alive = false } },
  pageLifetimes: { show() { this.refresh() } },
  methods: {
    refresh() { this.setData({ enabled: supportsVirtualUsers(), label: virtualUserLabel(), selected: slots.indexOf(virtualUser()) }) },
    async change(e: WechatMiniprogram.PickerChange) {
      if (this.data.busy || this.data.disabled) return
      const selected = slots[Number(e.detail.value)]
      if (selected === undefined) return
      this.setData({ busy: true })
      try { await switchTestIdentity(selected) } catch (error) { showError(error) }
      finally { if (this.data.alive) { this.setData({ busy: false }); this.refresh() } }
    },
  },
})
