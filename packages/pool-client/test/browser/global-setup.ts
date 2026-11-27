import { startPageServer } from "./server.ts"

export default async function globalSetup(): Promise<() => Promise<void>> {
	const server = await startPageServer()
	process.env.POOL_CLIENT_PAGE_URL = server.url
	return () => server.stop()
}
