import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { LettaSdkProvisioner } from './letta-sdk-provisioner.js'

const port = Number(process.env.PORT ?? 8787)
const app = createApp(new LettaSdkProvisioner())

serve({ fetch: app.fetch, port }, ({ port: boundPort }) => {
  console.log(`Continuity Studio server listening on http://127.0.0.1:${boundPort}`)
})
