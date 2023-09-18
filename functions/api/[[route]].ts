import { KVNamespace, R2Bucket } from '@cloudflare/workers-types'
import { zValidator } from '@hono/zod-validator'
import * as jwt from '@tsndr/cloudflare-worker-jwt'
import { Hono, MiddlewareHandler } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { cors } from 'hono/cors'
import { z } from 'zod'

type Optional<T, E extends keyof T> = Omit<T, E> & Partial<Pick<T, E>>

declare const crypto: import('@cloudflare/workers-types').Crypto

function generateId(length: number) {
	const bytes = crypto.getRandomValues(new Uint8Array(length + 2))
	return btoa(String.fromCharCode(...bytes))
		.replace(/[+/=]/g, '')
		.substring(0, length)
		.padEnd(length, '0')
}

type Env = {
	KV: KVNamespace,
	BUCKET: R2Bucket,
	ADMIN_SECRET: string,
	TOKEN_SECRET: string,
}

type User = {
	username: string,
	password: string,
	library_access: string[],
	admin_access: boolean,
	created_by?: string,
	timestamp: string,
}
type SafeUser = Optional<User, 'password' | 'created_by' | 'timestamp'>

type Actor = SafeUser | undefined

function hasLibraryAccess(libraryId: string, actor: Actor) {
	return actor?.admin_access || actor?.library_access.includes(libraryId)
}

function safeUser(user: User, actor: SafeUser) {
	const result: SafeUser = user
	delete result.password
	if (!actor.admin_access) {
		delete result.created_by
		delete result.timestamp
	}
	return result
}

type Library<A = Album> = {
	id: string,
	created_by: string,
	timestamp: string,
	albums: A[],
}
type SafeLibrary = Optional<Library<SafeAlbum>, 'created_by' | 'timestamp'>

function safeLibrary(library: Library, actor: Actor) {
	const result: SafeLibrary = library
	if (!actor?.admin_access) {
		delete result.created_by
		delete result.timestamp
	}
	if (!hasLibraryAccess(library.id, actor)) {
		result.albums = library.albums.map(a => safeAlbum(a, actor))
	}
	return result
}

type Album<P = Photo> = {
	id: string,
	name: string,
	cover?: string,
	public: boolean,
	created_by: string,
	timestamp: string,
	photos: P[],
}
type SafeAlbum = Optional<Album<SafePhoto>, 'created_by' | 'timestamp'>

function safeAlbum(album: Album, actor: Actor) {
	const result: SafeAlbum = album
	if (!actor?.admin_access) {
		delete result.created_by
		delete result.timestamp
		result.photos = album.photos.map(p => safePhoto(p, actor))
	}
	return result
}

type Photo = {
	id: string,
	author?: string,
	uploaded_by: string,
	timestamp: string,
}
type SafePhoto = Optional<Photo, 'uploaded_by' | 'timestamp'>

function safePhoto(photo: Photo, actor: Actor) {
	const result: SafePhoto = photo
	if (!actor?.admin_access) {
		delete result.uploaded_by
		delete result.timestamp
	}
	return result
}

const app = new Hono<{
	Bindings: Env,
	Variables: { user: SafeUser | undefined },
}>().basePath('/api')

app.use('*', cors({
	origin: '*',
	maxAge: 86400,
}))

app.use('*', async (c, next) => {
	const auth = c.req.header('Authorization')
	let user: SafeUser | undefined
	if (auth?.startsWith('Bearer ')) {
		const token = auth.slice(7)
		const isValid = await jwt.verify(token, c.env.TOKEN_SECRET, { throwError: true })
		if (isValid) {
			const { payload } = jwt.decode(token)
			if (typeof payload.username === 'string') {
				const userData = await c.env.KV.get(`user-${payload.username}`)
				if (userData !== null) {
					user = JSON.parse(userData)
					delete (user as any).password
				}
			}
		}
	} else if (c.env.ADMIN_SECRET !== undefined && auth === c.env.ADMIN_SECRET) {
		user = {
			username: 'admin',
			admin_access: true,
			library_access: [],
		}
	}
	c.set('user', user)
	await next()
})

app.options('*', (c) => {
	return c.text('', 204)
})

// Source: https://gist.github.com/chrisveness/770ee96945ec12ac84f134bf538d89fb

async function hashPassword(password: string, iterations = 1e4) {
	const pwUtf8 = new TextEncoder().encode(password)
	const pwKey = await crypto.subtle.importKey('raw', pwUtf8, 'PBKDF2', false, ['deriveBits'])
	const saltUint8 = crypto.getRandomValues(new Uint8Array(16))
	const params = { name: 'PBKDF2', hash: 'SHA-256', salt: saltUint8, iterations: iterations }
	const keyBuffer = await crypto.subtle.deriveBits(params, pwKey, 256)
	const keyArray = Array.from(new Uint8Array(keyBuffer))
	const saltArray = Array.from(new Uint8Array(saltUint8))
	const iterHex = ('000000' + iterations.toString(16)).slice(-6)
	const iterArray = iterHex.match(/.{2}/g)!.map(byte => parseInt(byte, 16))
	const compositeArray = ([] as number[]).concat(saltArray, iterArray, keyArray)
	const compositeStr = compositeArray.map(byte => String.fromCharCode(byte)).join('')
	return btoa('v01' + compositeStr)
}

async function verifyPassword(plain: string, hash: string) {
	const compositeStr = atob(hash)
	const version = compositeStr.slice(0, 3)
	const saltStr = compositeStr.slice(3, 19)
	const iterStr = compositeStr.slice(19, 22)
	const keyStr = compositeStr.slice(22, 54)
	if (version != 'v01') throw new Error('Invalid key')
	const saltUint8 = new Uint8Array(saltStr.match(/./g)!.map(ch => ch.charCodeAt(0)))
	const iterHex = iterStr.match(/./g)!.map(ch => ch.charCodeAt(0).toString(16)).join('')
	const iterations = parseInt(iterHex, 16)
	const pwUtf8 = new TextEncoder().encode(plain)
	const pwKey = await crypto.subtle.importKey('raw', pwUtf8, 'PBKDF2', false, ['deriveBits'])
	const params = { name: 'PBKDF2', hash: 'SHA-256', salt: saltUint8, iterations: iterations }
	const pwKeyBuffer = await crypto.subtle.deriveBits(params, pwKey, 256)
	const keyBuffer = new Uint8Array(keyStr.match(/./g)!.map(ch => ch.charCodeAt(0)))
	return crypto.subtle.timingSafeEqual(pwKeyBuffer, keyBuffer)
}

const postUserSchema = z.object({
	username: z.string().min(2).refine(s => /^[A-Za-z0-9._-]/.test(s)),
	password: z.string(),
	library_access: z.array(z.string()),
	admin_access: z.boolean(),
})
app.post('/user', zValidator('json', postUserSchema), async (c) => {
	const { user: admin } = c.var
	if (!admin?.admin_access) {
		return c.text('Unauthorized to create user', 401)
	}
	const body = c.req.valid('json')
	const existing = await c.env.KV.get(`user-${body.username}`)
	if (existing !== null) {
		return c.text(`User with username "${body.username}" already exists`, 400)
	}
	const passwordHash = await hashPassword(body.password)
	const user: User = {
		username: body.username,
		password: passwordHash,
		library_access: body.library_access,
		admin_access: body.admin_access,
		created_by: admin.username,
		timestamp: new Date().toISOString(),
	}
	await c.env.KV.put(`user-${user.username}`, JSON.stringify(user))
	return c.json(safeUser(user, admin))
})

app.get('/user/:username', async (c) => {
	const { user: authUser } = c.var
	const username = c.req.param('username')
	const userData = await c.env.KV.get(`user-${username}`)
	if (userData === null) {
		return c.text(`User "${username}" not found`, 404)
	}
	const user = JSON.parse(userData) as User
	if (authUser === undefined || authUser.username !== user.username) {
		return c.text(`Unauthorized to access user "${user.username}"`, 401)
	}
	return c.json(safeUser(user, authUser))
})

const loginSchema = z.object({
	username: z.string(),
	password: z.string(),
})
app.post('/login', zValidator('json', loginSchema), async (c) => {
	const body = c.req.valid('json')
	const username = body.username
	const userData = await c.env.KV.get(`user-${username}`)
	if (userData === null) {
		return c.text(`User "${username}" not found`, 404)
	}
	const user = JSON.parse(userData) as User
	const matches = await verifyPassword(body.password, user.password)
	if (!matches) {
		return c.text(`Incorrect password`, 401)
	}
	const token = await jwt.sign({
		username: body.username,
		exp: Math.floor(Date.now() / 1000) + (2 * (60 * 60)), // 2 hours
	}, c.env.TOKEN_SECRET)
	return c.json({
		token: token,
		user: safeUser(user, user),
	})
})

const getLibrary: MiddlewareHandler<{
	Bindings: Env,
	Variables: {
		user: SafeUser,
		library: Library,
		authorized: true,
	} | {
		user: undefined,
		library: Library,
		authorized: false,
	},
}> = async (c, next) => {
	const libraryId = c.req.query('library')
	if (!libraryId || !libraryId.match(/^[A-Za-z0-9_-]+$/)) {
		return c.text('Expected a valid "library" search parameter', 400)
	}
	let libraryData = await c.env.KV.get(`library-${libraryId}`)
	if (libraryData === null) {
		return c.text(`Library "${libraryId}" not found`, 404)
	}
	const library = JSON.parse(libraryData) as Library
	c.set('library', library)
	const user = c.var.user
	const authorized = user?.admin_access || user?.library_access.includes(library.id) || false
	c.set('authorized', authorized)
	if (!authorized) {
		library.albums = library.albums.filter(a => a.public)
	}
	await next()
}

const postLibrarySchema = z.object({
	id: z.string(),
})
app.post('/library', zValidator('json', postLibrarySchema), async (c) => {
	const { user } = c.var
	if (!user?.admin_access) {
		return c.text('Unauthorized to create library', 401)
	}
	const body = c.req.valid('json')
	const library: Library = {
		id: body.id,
		created_by: user.username,
		timestamp: new Date().toISOString(),
		albums: [],
	}
	await c.env.KV.put(`library-${library.id}`, JSON.stringify(library))
	return c.json(safeLibrary(library, user))
})

app.get('/library', getLibrary, async (c) => {
	const { user, library, authorized } = c.var
	let result: Library & { authorized?: boolean } = library
	result.authorized = authorized
	return c.json(safeLibrary(library, user))
})

const postAlbumSchema = z.object({
	name: z.string(),
	public: z.boolean().optional(),
})
app.post('/album', getLibrary, zValidator('json', postAlbumSchema), async (c) => {
	const { user, library, authorized } = c.var
	if (!authorized) {
		return c.text(`Unauthorized to access library "${library.id}"`, 401)
	}
	const body = c.req.valid('json')
	if (library.albums.find(a => a.name === body.name)) {
		return c.text(`Album with name "${body.name}" already exists`, 400)
	}
	const albumId = generateId(16)
	const album: Album = {
		id: albumId,
		name: body.name,
		public: body.public ?? false,
		created_by: user.username,
		timestamp: new Date().toISOString(),
		photos: [],
	}
	library.albums.push(album)
	await c.env.KV.put(`library-${library.id}`, JSON.stringify(library))
	return c.json(safeAlbum(album, user))
})

const patchAlbumSchema = postAlbumSchema.extend({
	cover: z.string().or(z.null()),
	photos: z.array(z.object({
		id: z.string(),
		author: z.string().optional(),
	})),
}).partial()
app.patch('/album/:id', getLibrary, zValidator('json', patchAlbumSchema), async (c) => {
	const albumId = c.req.param('id')
	const { user, library, authorized } = c.var
	if (!authorized) {
		return c.text(`Unauthorized to access library "${library.id}"`, 401)
	}
	const body = c.req.valid('json')
	const album = library.albums.find(a => a.id === albumId)
	if (!album) {
		return c.text(`Album "${albumId}" not found`, 404)
	}
	if (body.name) {
		album.name = body.name
	}
	if (body.photos !== undefined) {
		const deletedPhotos = album.photos.filter(p => !body.photos!.find(q => q.id === p.id))
		album.photos = body.photos.map(p => {
			const photo = album.photos.find(q => q.id === p.id)
			return {
				...photo,
				...p,
				uploaded_by: user.username,
				timestamp: new Date().toISOString(),
			} satisfies Photo
		})
		for (const photo of deletedPhotos) {
			if (album.cover === photo.id) {
				album.cover = undefined
			}
			await c.env.BUCKET.delete(photo.id)
			await c.env.BUCKET.delete(`thumb_${photo.id}`)
		}
	}
	if (body.cover && album.photos.some(p => p.id === body.cover)) {
		album.cover = body.cover
	} else if (body.cover === null) {
		delete album.cover
	}
	if (body.public !== undefined) {
		album.public = body.public
	}
	await c.env.KV.put(`library-${library.id}`, JSON.stringify(library))
	return c.json(safeAlbum(album, user))
})

app.delete('/album/:id', getLibrary, async (c) => {
	const albumId = c.req.param('id')
	const { library, authorized } = c.var
	if (!authorized) {
		return c.text(`Unauthorized to access library "${library.id}"`, 401)
	}
	const albumIndex = library.albums.findIndex(a => a.id === albumId)
	if (albumIndex === -1) {
		return c.text(`Album "${albumId}" not found`, 404)
	}
	library.albums.splice(albumIndex, 1)
	await c.env.KV.put(`library-${library.id}`, JSON.stringify(library))
	return c.text('')
})

function getObjectId(id: string, size?: string) {
	if (size === 'original') return id
	if (size === 'thumbnail') return `thumb_${id}`
	if (size === 'preview') return `preview_${id}`
	return undefined
}

app.post('/photo', getLibrary, async (c) => {
	const { user, library, authorized } = c.var
	if (!authorized) {
		return c.text(`Unauthorized to access library "${library.id}"`, 401)
	}
	const photoId = generateId(16)
	const formData = await c.req.formData()
	for (const size of ['original', 'thumbnail', 'preview'] as const) {
		const file = formData.get(size)
		if (!(file instanceof File)) {
			return c.text(`Expected "${size}" to be a File`, 400)
		}
		const objectId = getObjectId(photoId, size)!
		await c.env.BUCKET.put(objectId, file as any, {
			httpMetadata: {
				contentType: file.type,
			},
		})
	}
	const photo: Photo = {
		id: photoId,
		uploaded_by: user.username,
		timestamp: new Date().toISOString(),
	}
	return c.json(safePhoto(photo, user))
})

app.get('/photo/:id', async (c) => {
	const photoId = c.req.param('id')
	const size = c.req.query('size')
	let objectId = getObjectId(photoId, size)
	if (objectId === undefined) {
		return c.text('Expected a valid "size" search parameter', 400)
	}
	const photo = await c.env.BUCKET.get(objectId)
	if (photo === null) {
		return c.text('Photo not found', 404)
	}
	const status = photo.body ? 200 : 304
	return c.body(photo.body as any, status, {
		'Cache-Control': 'public, max-age=604800, immutable',
		'Content-Type': photo.httpMetadata?.contentType ?? 'image/jpeg',
		'Content-Length': photo.size.toFixed(),
		'Etag': photo.httpEtag,
	})
})

export const onRequest = handle(app)
