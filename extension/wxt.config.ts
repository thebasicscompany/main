import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'Basics Runtime',
    description: 'Basics runtime context sync, workflow recording, and approvals.',
    permissions: ['alarms', 'cookies', 'notifications', 'storage', 'tabs'],
    host_permissions: ['https://api.trybasics.ai/*'],
    optional_host_permissions: ['https://*/*'],
  },
})
