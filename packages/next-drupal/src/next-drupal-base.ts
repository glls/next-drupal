import { stringify } from "qs"
import { JsonApiErrors } from "./jsonapi-errors"
import { logger as defaultLogger } from "./logger"
import type {
  AccessToken,
  BaseUrl,
  EndpointSearchParams,
  FetchOptions,
  JsonApiResponse,
  Locale,
  Logger,
  NextDrupalAuth,
  NextDrupalAuthAccessToken,
  NextDrupalAuthClientIdSecret,
  NextDrupalAuthUsernamePassword,
  NextDrupalBaseOptions,
  PathPrefix,
} from "./types"

const DEFAULT_API_PREFIX = ""
const DEFAULT_FRONT_PAGE = "/home"
const DEFAULT_WITH_AUTH = false

// From simple_oauth.
const DEFAULT_AUTH_URL = "/oauth/token"

// See https://jsonapi.org/format/#content-negotiation.
const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
}

/**
 * The base class for NextDrupal clients.
 */
export class NextDrupalBase {
  accessToken?: NextDrupalBaseOptions["accessToken"]

  baseUrl: BaseUrl

  fetcher?: NextDrupalBaseOptions["fetcher"]

  frontPage: string

  isDebugEnabled: boolean

  logger: Logger

  withAuth: boolean

  private _apiPrefix: string

  private _auth?: NextDrupalAuth

  private _headers: Headers

  private _token?: AccessToken

  private _tokenExpiresOn?: number

  private _tokenRequestDetails?: NextDrupalAuthClientIdSecret

  /**
   * Instantiates a new NextDrupalBase.
   *
   * const client = new NextDrupalBase(baseUrl)
   *
   * @param {baseUrl} baseUrl The baseUrl of your Drupal site. Do not add the /jsonapi suffix.
   * @param {options} options Options for NextDrupalBase.
   */
  constructor(baseUrl: BaseUrl, options: NextDrupalBaseOptions = {}) {
    if (!baseUrl || typeof baseUrl !== "string") {
      throw new Error("The 'baseUrl' param is required.")
    }

    const {
      accessToken,
      apiPrefix = DEFAULT_API_PREFIX,
      auth,
      debug = false,
      fetcher,
      frontPage = DEFAULT_FRONT_PAGE,
      headers = DEFAULT_HEADERS,
      logger = defaultLogger,
      withAuth = DEFAULT_WITH_AUTH,
    } = options

    this.accessToken = accessToken
    this.apiPrefix = apiPrefix
    this.auth = auth
    this.baseUrl = baseUrl
    this.fetcher = fetcher
    this.frontPage = frontPage
    this.isDebugEnabled = !!debug
    this.headers = headers
    this.logger = logger
    this.withAuth = withAuth

    this.debug("Debug mode is on.")
  }

  set apiPrefix(apiPrefix: string) {
    this._apiPrefix =
      apiPrefix === "" || apiPrefix.startsWith("/")
        ? apiPrefix
        : `/${apiPrefix}`
  }

  get apiPrefix() {
    return this._apiPrefix
  }

  set auth(auth: NextDrupalAuth) {
    if (typeof auth === "object") {
      const checkUsernamePassword = auth as NextDrupalAuthUsernamePassword
      const checkAccessToken = auth as NextDrupalAuthAccessToken
      const checkClientIdSecret = auth as NextDrupalAuthClientIdSecret

      if (
        checkUsernamePassword.username !== undefined ||
        checkUsernamePassword.password !== undefined
      ) {
        if (
          !checkUsernamePassword.username ||
          !checkUsernamePassword.password
        ) {
          throw new Error(
            "'username' and 'password' are required for auth. See https://next-drupal.org/docs/client/auth"
          )
        }
      } else if (
        checkAccessToken.access_token !== undefined ||
        checkAccessToken.token_type !== undefined
      ) {
        if (!checkAccessToken.access_token || !checkAccessToken.token_type) {
          throw new Error(
            "'access_token' and 'token_type' are required for auth. See https://next-drupal.org/docs/client/auth"
          )
        }
      } else if (
        !checkClientIdSecret.clientId ||
        !checkClientIdSecret.clientSecret
      ) {
        throw new Error(
          "'clientId' and 'clientSecret' are required for auth. See https://next-drupal.org/docs/client/auth"
        )
      }

      this._auth = {
        ...(isClientIdSecretAuth(auth) ? { url: DEFAULT_AUTH_URL } : {}),
        ...auth,
      }
    } else {
      this._auth = auth
    }
  }

  get auth() {
    return this._auth
  }

  set headers(headers: HeadersInit) {
    this._headers = new Headers(headers)
  }

  get headers() {
    return this._headers
  }

  set token(token: AccessToken) {
    this._token = token
    this._tokenExpiresOn = Date.now() + token.expires_in * 1000
  }

  get token() {
    return this._token
  }

  /**
   * Fetches a resource from the given input URL or path.
   *
   * @param {RequestInfo} input The url to fetch from.
   * @param {FetchOptions} init The fetch options with `withAuth`.
   *   If `withAuth` is set, `fetch` will fetch an `Authorization` header before making the request.
   * @returns {Promise<Response>} The fetch response.
   * @remarks
   * To provide your own custom fetcher, see the fetcher docs.
   * @example
   * ```ts
   * const url = drupal.buildUrl("/jsonapi/node/article", {
   *   sort: "-created",
   *   "fields[node--article]": "title,path",
   * })
   *
   * const response = await drupal.fetch(url.toString())
   * ```
   */
  async fetch(
    input: RequestInfo,
    { withAuth, ...init }: FetchOptions = {}
  ): Promise<Response> {
    init.credentials = "include"

    // Merge the init.headers with this.headers
    const headers = new Headers(this.headers)
    if (init?.headers) {
      const initHeaders = new Headers(init?.headers)
      for (const key of initHeaders.keys()) {
        headers.set(key, initHeaders.get(key))
      }
    }

    // Set Authorization header.
    if (withAuth) {
      headers.set(
        "Authorization",
        await this.getAuthorizationHeader(
          withAuth === true ? this.auth : withAuth
        )
      )
    }

    init.headers = headers

    if (typeof input === "string" && input.startsWith("/")) {
      input = `${this.baseUrl}${input}`
    }

    if (this.fetcher) {
      this.debug(`Using custom fetcher, fetching: ${input}`)

      return await this.fetcher(input, init)
    }

    this.debug(`Using default fetch, fetching: ${input}`)

    return await fetch(input, init)
  }

  /**
   * Gets the authorization header value based on the provided auth configuration.
   *
   * @param {NextDrupalAuth} auth The auth configuration.
   * @returns {Promise<string>} The authorization header value.
   */
  async getAuthorizationHeader(auth: NextDrupalAuth) {
    let header: string

    if (isBasicAuth(auth)) {
      const basic = Buffer.from(`${auth.username}:${auth.password}`).toString(
        "base64"
      )
      header = `Basic ${basic}`
      this.debug("Using basic authorization header.")
    } else if (isClientIdSecretAuth(auth)) {
      // Fetch an access token and add it to the request. getAccessToken()
      // throws an error if it fails to get an access token.
      const token = await this.getAccessToken(auth)
      header = `Bearer ${token.access_token}`
      this.debug(
        "Using access token authorization header retrieved from Client Id/Secret."
      )
    } else if (isAccessTokenAuth(auth)) {
      header = `${auth.token_type} ${auth.access_token}`
      this.debug("Using access token authorization header.")
    } else if (typeof auth === "string") {
      header = auth
      this.debug("Using custom authorization header.")
    } else if (typeof auth === "function") {
      header = auth()
      this.debug("Using custom authorization callback.")
    } else {
      throw new Error(
        "auth is not configured. See https://next-drupal.org/docs/client/auth"
      )
    }

    return header
  }

  /**
   * Builds a URL with the given path and search parameters.
   *
   * @param {string} path The path for the url. Example: "/example"
   * @param {string | Record<string, string> | URLSearchParams | JsonApiParams} searchParams Optional query parameters.
   * @returns {URL} The constructed URL.
   * @example
   * ```ts
   * const drupal = new DrupalClient("https://example.com")
   *
   * // https://drupal.org
   * drupal.buildUrl("https://drupal.org").toString()
   *
   * // https://example.com/foo
   * drupal.buildUrl("/foo").toString()
   *
   * // https://example.com/foo?bar=baz
   * client.buildUrl("/foo", { bar: "baz" }).toString()
   * ```
   *
   * Build a URL from `DrupalJsonApiParams`
   * ```ts
   * const params = {
   *   getQueryObject: () => ({
   *     sort: "-created",
   *     "fields[node--article]": "title,path",
   *   }),
   * }
   *
   * // https://example.com/jsonapi/node/article?sort=-created&fields%5Bnode--article%5D=title%2Cpath
   * drupal.buildUrl("/jsonapi/node/article", params).toString()
   * ```
   */
  buildUrl(path: string, searchParams?: EndpointSearchParams): URL {
    const url = new URL(path, this.baseUrl)

    const search =
      // Handle DrupalJsonApiParams objects.
      searchParams &&
      typeof searchParams === "object" &&
      "getQueryObject" in searchParams
        ? searchParams.getQueryObject()
        : searchParams

    if (search) {
      // Use stringify instead of URLSearchParams for nested params.
      url.search = stringify(search)
    }

    return url
  }

  /**
   * Builds an endpoint URL with the given options.
   *
   * @param {Object} options The options for building the endpoint.
   * @param {string} options.locale The locale.
   * @param {string} options.path The path.
   * @param {EndpointSearchParams} options.searchParams The search parameters.
   * @returns {Promise<string>} The constructed endpoint URL.
   */
  async buildEndpoint({
    locale = "",
    path = "",
    searchParams,
  }: {
    locale?: string
    path?: string
    searchParams?: EndpointSearchParams
  } = {}): Promise<string> {
    const localeSegment = locale ? `/${locale}` : ""

    if (path && !path.startsWith("/")) {
      path = `/${path}`
    }

    return this.buildUrl(
      `${localeSegment}${this.apiPrefix}${path}`,
      searchParams
    ).toString()
  }

  /**
   * Constructs a path from the given segment and options.
   *
   * @param {string | string[]} segment The path segment.
   * @param {Object} options The options for constructing the path.
   * @param {Locale} options.locale The locale.
   * @param {Locale} options.defaultLocale The default locale.
   * @param {PathPrefix} options.pathPrefix The path prefix.
   * @returns {string} The constructed path.
   */
  constructPathFromSegment(
    segment: string | string[],
    options: {
      locale?: Locale
      defaultLocale?: Locale
      pathPrefix?: PathPrefix
    } = {}
  ) {
    let { pathPrefix = "" } = options
    const { locale, defaultLocale } = options

    // Ensure pathPrefix starts with a "/" and does not end with a "/".
    if (pathPrefix) {
      if (!pathPrefix?.startsWith("/")) {
        pathPrefix = `/${options.pathPrefix}`
      }
      if (pathPrefix.endsWith("/")) {
        pathPrefix = pathPrefix.slice(0, -1)
      }
    }

    // If the segment is given as an array of segments, join the parts.
    if (!Array.isArray(segment)) {
      segment = segment ? [segment] : []
    }
    segment = segment.map((part) => encodeURIComponent(part)).join("/")

    if (!segment && !pathPrefix) {
      // If no pathPrefix is given and the segment is empty, then the path
      // should be the homepage.
      segment = this.frontPage
    }

    // Ensure the segment starts with a "/" and does not end with a "/".
    if (segment && !segment.startsWith("/")) {
      segment = `/${segment}`
    }
    if (segment.endsWith("/")) {
      segment = segment.slice(0, -1)
    }

    return this.addLocalePrefix(`${pathPrefix}${segment}`, {
      locale,
      defaultLocale,
    })
  }

  /**
   * Adds a locale prefix to the given path.
   *
   * @param {string} path The path.
   * @param {Object} options The options for adding the locale prefix.
   * @param {Locale} options.locale The locale.
   * @param {Locale} options.defaultLocale The default locale.
   * @returns {string} The path with the locale prefix.
   */
  addLocalePrefix(
    path: string,
    options: { locale?: Locale; defaultLocale?: Locale } = {}
  ) {
    const { locale, defaultLocale } = options

    if (!path.startsWith("/")) {
      path = `/${path}`
    }

    let localePrefix = ""
    if (locale && !path.startsWith(`/${locale}`) && locale !== defaultLocale) {
      localePrefix = `/${locale}`
    }

    return `${localePrefix}${path}`
  }

  /**
   * Retrieve an access token.
   *
   * @param {NextDrupalAuthClientIdSecret} clientIdSecret The client ID and secret.
   * @returns {Promise<AccessToken>} The access token.
   * @remarks
   * If options is not provided, `DrupalClient` will use the `clientId` and `clientSecret` configured in `auth`.
   * @example
   * ```ts
   * const accessToken = await drupal.getAccessToken({
   *   clientId: "7034f4db-7151-466f-a711-8384bddb9e60",
   *   clientSecret: "d92Fm^ds",
   * })
   * ```
   */
  async getAccessToken(
    clientIdSecret?: NextDrupalAuthClientIdSecret
  ): Promise<AccessToken> {
    if (this.accessToken) {
      return this.accessToken
    }

    let auth: NextDrupalAuthClientIdSecret
    if (isClientIdSecretAuth(clientIdSecret)) {
      auth = {
        url: DEFAULT_AUTH_URL,
        ...clientIdSecret,
      }
    } else if (isClientIdSecretAuth(this.auth)) {
      auth = { ...this.auth }
    } else if (typeof this.auth === "undefined") {
      throw new Error(
        "auth is not configured. See https://next-drupal.org/docs/client/auth"
      )
    } else {
      throw new Error(
        `'clientId' and 'clientSecret' required. See https://next-drupal.org/docs/client/auth`
      )
    }

    const url = this.buildUrl(auth.url)

    // Ensure that the unexpired token was using the same scope and client
    // credentials as the current request before re-using it.
    if (
      this.token &&
      Date.now() < this._tokenExpiresOn &&
      this._tokenRequestDetails?.clientId === auth?.clientId &&
      this._tokenRequestDetails?.clientSecret === auth?.clientSecret &&
      this._tokenRequestDetails?.scope === auth?.scope
    ) {
      this.debug(`Using existing access token.`)
      return this.token
    }

    this.debug(`Fetching new access token.`)

    // Use BasicAuth to retrieve the access token.
    const clientCredentials: NextDrupalAuthUsernamePassword = {
      username: auth.clientId,
      password: auth.clientSecret,
    }
    const body = new URLSearchParams({ grant_type: "client_credentials" })

    if (auth?.scope) {
      body.set("scope", auth.scope)

      this.debug(`Using scope: ${auth.scope}`)
    }

    const response = await this.fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: await this.getAuthorizationHeader(clientCredentials),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    })

    await this.throwIfJsonErrors(
      response,
      "Error while fetching new access token: "
    )

    const result: AccessToken = await response.json()

    this.token = result

    this._tokenRequestDetails = auth

    return result
  }

  /**
   * Validates the draft URL using the provided search parameters.
   *
   * @param {URLSearchParams} searchParams The search parameters.
   * @returns {Promise<Response>} The validation response.
   */
  async validateDraftUrl(searchParams: URLSearchParams): Promise<Response> {
    const path = searchParams.get("path")

    this.debug(`Fetching draft url validation for ${path}.`)

    // Fetch the headless CMS to check if the provided `path` exists
    let response: Response
    try {
      // Validate the draft url.
      const validateUrl = this.buildUrl("/next/draft-url").toString()
      response = await this.fetch(validateUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(Object.fromEntries(searchParams.entries())),
      })
    } catch (error) {
      response = new Response(JSON.stringify({ message: error.message }), {
        status: 401,
      })
    }

    this.debug(
      response.status !== 200
        ? `Could not validate path, ${path}`
        : `Validated path, ${path}`
    )

    return response
  }

  /**
   * Logs a debug message if debug mode is enabled.
   *
   * @param {string} message The debug message.
   */
  debug(message) {
    this.isDebugEnabled && this.logger.debug(message)
  }

  /**
   * Throws an error if the response contains JSON:API errors.
   *
   * @param {Response} response The fetch response.
   * @param {string} messagePrefix The error message prefix.
   * @throws {JsonApiErrors} The JSON:API errors.
   */
  async throwIfJsonErrors(response: Response, messagePrefix = "") {
    if (!response?.ok) {
      const errors = await this.getErrorsFromResponse(response)
      throw new JsonApiErrors(errors, response.status, messagePrefix)
    }
  }

  /**
   * Extracts errors from the fetch response.
   *
   * @param {Response} response The fetch response.
   * @returns {Promise<string | JsonApiResponse>} The extracted errors.
   */
  async getErrorsFromResponse(response: Response) {
    const type = response.headers.get("content-type")
    let error: JsonApiResponse | { message: string }

    if (type === "application/json") {
      error = await response.json()

      if (error?.message) {
        return error.message as string
      }
    }

    // Construct error from response.
    // Check for type to ensure this is a JSON:API formatted error.
    // See https://jsonapi.org/format/#errors.
    else if (type === "application/vnd.api+json") {
      error = (await response.json()) as JsonApiResponse

      if (error?.errors?.length) {
        return error.errors
      }
    }

    return response.statusText
  }
}

/**
 * Checks if the provided auth configuration is basic auth.
 *
 * @param {NextDrupalAuth} auth The auth configuration.
 * @returns {boolean} True if the auth configuration is basic auth, false otherwise.
 */
export function isBasicAuth(
  auth: NextDrupalAuth
): auth is NextDrupalAuthUsernamePassword {
  return (
    (auth as NextDrupalAuthUsernamePassword)?.username !== undefined &&
    (auth as NextDrupalAuthUsernamePassword)?.password !== undefined
  )
}

/**
 * Checks if the provided auth configuration is access token auth.
 *
 * @param {NextDrupalAuth} auth The auth configuration.
 * @returns {boolean} True if the auth configuration is access token auth, false otherwise.
 */
export function isAccessTokenAuth(
  auth: NextDrupalAuth
): auth is NextDrupalAuthAccessToken {
  return (
    (auth as NextDrupalAuthAccessToken)?.access_token !== undefined &&
    (auth as NextDrupalAuthAccessToken)?.token_type !== undefined
  )
}

/**
 * Checks if the provided auth configuration is client ID and secret auth.
 *
 * @param {NextDrupalAuth} auth The auth configuration.
 * @returns {boolean} True if the auth configuration is client ID and secret auth, false otherwise.
 */
export function isClientIdSecretAuth(
  auth: NextDrupalAuth
): auth is NextDrupalAuthClientIdSecret {
  return (
    (auth as NextDrupalAuthClientIdSecret)?.clientId !== undefined &&
    (auth as NextDrupalAuthClientIdSecret)?.clientSecret !== undefined
  )
}
