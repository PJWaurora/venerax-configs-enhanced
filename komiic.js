class Komiic extends ComicSource {
  init() {
    this.ensureLogin();
  }

  async ensureLogin() {
    let token = this.loadData("token");
    if (token) return;

    // WebView 登录回调是异步的；请求开始前再次从 Cookie 同步 Token，避免
    // 回调尚未完成时被当作游客请求。
    token = await this._loadWebToken();
    if (token) {
      this.saveData("token", token);
      return;
    }

    const accountData = this.loadData("account");
    if (accountData && Array.isArray(accountData) && accountData.length >= 2) {
      try {
        await this.account.login(accountData[0], accountData[1]);
      } catch (e) {}
    }
  }

  // 此漫画源的名称
  name = "Komiic";

  // 唯一标识符
  key = "Komiic";

  static TICKET_REFRESH_TTL_MS = 8 * 60 * 1000;

  static TICKET_FORCE_COOLDOWN_MS = 10 * 1000;

  version = "1.1.11";

  minAppVersion = "1.0.0";

  // 更新链接
  url = "https://cdn.jsdelivr.net/gh/PJWaurora/venerax-configs-enhanced@main/komiic.js";

  // 可选访问域名，默认主站
  get baseUrl() {
    return this.loadSetting("domain") || "https://komiic.cc";
  }

  get headers() {
    let token = this.loadData("token");
    let headers = {
      Referer: this.baseUrl + "/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      headers["cookie"] = `komiic-access-token=${token}`;
    }
    return headers;
  }

  _tokenFromCookies(cookies) {
    if (!Array.isArray(cookies)) return null;
    let cookie = cookies.find(
      (item) => item?.name === "komiic-access-token" && item?.value,
    );
    return cookie?.value || null;
  }

  async _loadWebToken() {
    // 登录页固定在 komiic.com，而大陆线路默认是 komiic.cc；两者的
    // host-only cookie 不会互相返回，不能只读取当前 baseUrl。
    for (let domain of [this.baseUrl, "https://komiic.com", "https://komiic.cc"]) {
      try {
        let token = this._tokenFromCookies(await Network.getCookies(domain));
        if (token) return token;
      } catch (e) {}
    }
    return null;
  }

  // 根据当前访问域名自动对齐封面域名（komiic.cc <-> komiic.com）
  _fixCoverUrl(url) {
    if (!url || typeof url !== "string") return url;
    try {
      if (this.baseUrl.indexOf("komiic.com") >= 0) {
        if (url.includes("public.komiic.cc")) {
          return url.replace("public.komiic.cc", "public.komiic.com");
        }
      } else if (url.includes("public.komiic.com")) {
        return url.replace("public.komiic.com", "public.komiic.cc");
      }
      return url;
    } catch {
      return url;
    }
  }

  _isTransientResetError(err) {
    const msg = (err == null ? "" : String(err)).toLowerCase();
    return (
      msg.indexOf("connection reset") >= 0 ||
      msg.indexOf("broken pipe") >= 0 ||
      msg.indexOf("unexpected eof") >= 0 ||
      msg.indexOf("connection closed") >= 0 ||
      msg.indexOf("os error 54") >= 0 ||
      msg.indexOf("os error 104") >= 0 ||
      msg.indexOf("os error 32") >= 0
    );
  }

  _decodeJwtExp(token) {
    if (!token || typeof token !== "string") return null;
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4 !== 0) b64 += "=";
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let bin = "";
      for (let i = 0; i < b64.length; i += 4) {
        const a = chars.indexOf(b64[i]);
        const b = chars.indexOf(b64[i + 1]);
        const c = b64[i + 2] === "=" ? 0 : chars.indexOf(b64[i + 2]);
        const d = b64[i + 3] === "=" ? 0 : chars.indexOf(b64[i + 3]);
        const triple = (a << 18) | (b << 12) | (c << 6) | d;
        bin += String.fromCharCode((triple >> 16) & 255);
        if (b64[i + 2] !== "=") bin += String.fromCharCode((triple >> 8) & 255);
        if (b64[i + 3] !== "=") bin += String.fromCharCode(triple & 255);
      }
      const payload = JSON.parse(bin);
      return typeof payload.exp === "number" ? payload.exp : null;
    } catch (e) {
      return null;
    }
  }

  async _refreshAccessToken() {
    for (let domain of this._loginDomains()) {
      try {
        let headers = { ...this.headers, Referer: domain + "/" };
        let res = await Network.post(domain + "/auth/refresh", headers, {});
        if (res.status === 200) {
          let setCookie = res.headers?.["set-cookie"] || res.headers?.["Set-Cookie"];
          let newToken = this._extractJwtFromSetCookie(setCookie);
          if (!newToken) {
            newToken = await this._loadWebToken();
          }
          if (newToken) {
            this.saveData("token", newToken);
            return newToken;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  async _fetchQuotaDiagnostic(base) {
    let account = null;
    let limitInfo = null;
    const headers = { ...this.headers, Referer: base + "/" };
    try {
      const accRes = await Network.post(base + "/api/query", headers, {
        operationName: "accountQuery",
        query: "query accountQuery { account { id email nickname } }",
      });
      if (accRes.status === 200 && accRes.body) {
        const accJson = JSON.parse(accRes.body);
        if (accJson.data?.account?.id && accJson.data.account.id !== "0") {
          account = accJson.data.account;
        }
      }
    } catch (e) {}
    try {
      const limRes = await Network.post(base + "/api/query", headers, {
        operationName: "getImageLimit",
        query: "query getImageLimit { getImageLimit { limit usage resetInSeconds } }",
      });
      if (limRes.status === 200 && limRes.body) {
        const limJson = JSON.parse(limRes.body);
        if (limJson.data?.getImageLimit) {
          limitInfo = limJson.data.getImageLimit;
        }
      }
    } catch (e) {}
    return { account, limitInfo };
  }

  async queryJson(query) {
    await this.ensureLogin();

    const currentToken = this.loadData("token");
    if (currentToken) {
      const exp = this._decodeJwtExp(currentToken);
      const nowSec = Math.floor(Date.now() / 1000);
      if (exp && exp < nowSec + 5 * 3600) {
        await this._refreshAccessToken();
      }
    }

    let domains = [this.baseUrl];
    if (!domains.includes("https://komiic.cc")) {
      domains.push("https://komiic.cc");
    }
    if (!domains.includes("https://komiic.com")) {
      domains.push("https://komiic.com");
    }

    let lastErr = null;
    let quotaHitBase = null;
    for (let i = 0; i < domains.length; i++) {
      const base = domains[i];
      const maxAttempts = i === 0 ? 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          let headers = {
            ...this.headers,
            Referer: base + "/",
          };
          let res = await Network.post(
            base + "/api/query",
            headers,
            query,
          );

          if (res.status !== 200) {
            throw `Invalid Status Code ${res.status}`;
          }

          let json = JSON.parse(res.body);

          if (json.errors != undefined) {
            const errorInfo = json.errors[0]?.message?.toString() || "";
            if (
              errorInfo.indexOf("token is expired") >= 0 ||
              errorInfo.indexOf("no token") >= 0 ||
              errorInfo.indexOf("jwt expired") >= 0 ||
              errorInfo.indexOf("Daily image quota exceeded") >= 0
            ) {
              // 1. 先尝试官方 /auth/refresh 刷新 JWT
              let refreshed = await this._refreshAccessToken();
              if (refreshed) {
                try {
                  let retryRes = await Network.post(
                    base + "/api/query",
                    { ...this.headers, Referer: base + "/" },
                    query,
                  );
                  if (retryRes.status === 200) {
                    let retryJson = JSON.parse(retryRes.body);
                    if (retryJson.errors == undefined) {
                      return retryJson;
                    }
                  }
                } catch (e) {}
              }
              // 2. 若保存了邮箱密码则尝试重新登录
              const accountData = this.loadData("account");
              if (accountData && Array.isArray(accountData) && accountData.length >= 2) {
                this.deleteData("token");
                try {
                  await this.account.login(accountData[0], accountData[1]);
                  let retryHeaders = { ...this.headers, Referer: base + "/" };
                  let retryRes = await Network.post(
                    base + "/api/query",
                    retryHeaders,
                    query,
                  );
                  if (retryRes.status === 200) {
                    let retryJson = JSON.parse(retryRes.body);
                    if (retryJson.errors == undefined) {
                      return retryJson;
                    }
                  }
                } catch (e) {}
              }
            }
            if (errorInfo.indexOf("Daily image quota exceeded") >= 0) {
              quotaHitBase = base;
              lastErr = errorInfo;
              // 尝试切换到下一个域名（如从 komiic.cc 镜像切到 komiic.com 主站）
              break;
            }
            throw {
              _komiicFatal: true,
              message: errorInfo || "Komiic GraphQL 请求失败",
            };
          }

          return json;
        } catch (err) {
          if (err && err._komiicFatal) {
            throw err.message;
          }
          lastErr = err;
          if (attempt + 1 < maxAttempts && this._isTransientResetError(err)) {
            continue;
          }
          break;
        }
      }
    }

    if (quotaHitBase) {
      const diag = await this._fetchQuotaDiagnostic(quotaHitBase);
      const usageText = diag.limitInfo
        ? `${diag.limitInfo.usage}/${diag.limitInfo.limit}`
        : "已达上限";
      const resetSec = Number(diag.limitInfo?.resetInSeconds || 0);
      const resetText =
        resetSec > 0
          ? `，约 ${Math.max(1, Math.ceil(resetSec / 3600))} 小时后重置`
          : "";
      if (diag.account) {
        const who = diag.account.nickname || diag.account.email || diag.account.id;
        throw `Komiic 账号（${who}）今日图片配额已用尽（${usageText}${resetText}）。Komiic 对普通已登录账号同样存在每日图片上限，需等待配额重置或赞助提升额度。`;
      }
      throw `Komiic 当前未处于有效登录态（Token 可能已过期，按游客/代理出口 IP 配额 ${usageText}${resetText}），请在漫画源设置中退出后重新登录，或切换代理节点。`;
    }
    throw lastErr || "Komiic 连接失败";
  }

  async queryComics(query) {
    let operationName = query["operationName"];
    let json = await this.queryJson(query);

    const fixCover = this._fixCoverUrl.bind(this);

    function parseComic(comic) {
      let author = "";
      if (comic.authors.length > 0) {
        author = comic.authors[0].name;
      }
      let tags = [];
      comic.categories.forEach((c) => {
        tags.push(c.name);
      });

      function getTimeDifference(date) {
        const now = new Date();
        const timeDifference = now - date;

        const millisecondsPerHour = 1000 * 60 * 60;
        const millisecondsPerDay = millisecondsPerHour * 24;

        if (timeDifference < millisecondsPerHour) {
          return "剛剛更新";
        } else if (timeDifference < millisecondsPerDay) {
          const hours = Math.floor(timeDifference / millisecondsPerHour);
          return `${hours}小時前更新`;
        } else {
          const days = Math.floor(timeDifference / millisecondsPerDay);
          return `${days}天前更新`;
        }
      }

      let updateTime = new Date(comic.dateUpdated);
      let description = getTimeDifference(updateTime);
      let formatedTime = `${updateTime.getFullYear()}-${updateTime.getMonth() + 1}-${updateTime.getDate()}`;

      return {
        id: comic.id,
        title: comic.title,
        subTitle: author,
        cover: fixCover(comic.imageUrl),
        tags: tags,
        description: description,
        updateTime: formatedTime,
      };
    }

    return {
      comics: json.data[operationName].map(parseComic),
      // 没找到最大页数的接口
      maxPage: null,
    };
  }

  _extractJwtFromSetCookie(setCookie) {
    if (!setCookie) return null;
    const raw = Array.isArray(setCookie) ? setCookie.join(", ") : String(setCookie);
    const re = /komiic-access-token=([^;,\s]+)/gi;
    let bestJwt = null;
    let fallbackToken = null;
    let match;
    while ((match = re.exec(raw)) !== null) {
      let val = (match[1] || "").trim();
      if (!val || val.length <= 20) continue;
      if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val)) {
        bestJwt = val;
      } else {
        fallbackToken = val;
      }
    }
    return bestJwt || fallbackToken;
  }

  _loginDomains() {
    let domains = [];
    for (let d of [this.baseUrl, "https://komiic.com", "https://komiic.cc"]) {
      if (d && !domains.includes(d)) domains.push(d);
    }
    return domains;
  }

  async _verifyToken(token) {
    if (!token || typeof token !== "string") return false;
    for (let domain of this._loginDomains()) {
      try {
        let checkRes = await Network.post(
          domain + "/api/query",
          {
            Referer: domain + "/",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            cookie: `komiic-access-token=${token}`,
          },
          {
            operationName: "accountQuery",
            query: "query accountQuery { account { id email nickname } }",
          },
        );
        if (checkRes.status === 200 && checkRes.body) {
          let checkJson = JSON.parse(checkRes.body);
          if (checkJson.data?.account?.id && checkJson.data.account.id !== "0") {
            return true;
          }
        }
      } catch (e) {}
    }
    return false;
  }

  /// 账号
  account = {
    login: async (account, pwd) => {
      const email = String(account || "").trim();
      const errors = [];

      for (let domain of this._loginDomains()) {
        let res;
        try {
          res = await Network.post(
            domain + "/api/login",
            {
              Referer: domain + "/",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              "Content-Type": "application/json",
            },
            {
              email: email,
              password: pwd,
            },
          );
        } catch (e) {
          errors.push(`${domain}: ${e}`);
          continue;
        }

        let token = null;
        let setCookie = res.headers?.["set-cookie"] || res.headers?.["Set-Cookie"];
        token = this._extractJwtFromSetCookie(setCookie);
        if (!token && res.body) {
          try {
            let json = JSON.parse(res.body);
            token = json.token || json.data?.token || json.accessToken || null;
          } catch (e) {}
        }
        if (!token && res.status === 200) {
          token = await this._loadWebToken();
        }

        if (token) {
          let verified = false;
          try {
            verified = await this._verifyToken(token);
          } catch (e) {
            verified = res.status === 200;
          }
          if (verified || res.status === 200) {
            this.saveData("token", token);
            this.saveData("account", [email, pwd]);
            return "ok";
          }
        }

        let detail = "";
        if (res.body) {
          try {
            let errJson = JSON.parse(res.body);
            detail = errJson.message || errJson.error || errJson.msg || "";
          } catch (e) {
            detail = String(res.body).replace(/\s+/g, " ").trim().slice(0, 120);
          }
        }
        errors.push(`${domain} HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }

      throw `登录失败（请确认填写的是注册邮箱而非昵称；也可改用网页登录或 Cookie 登录）。详情: ${errors.join(" | ")}`;
    },

    loginWithCookies: {
      fields: ["komiic-access-token"],
      validate: async (values) => {
        let raw = Array.isArray(values) ? String(values[0] || "").trim() : "";
        raw = raw
          .replace(/^komiic-access-token=/i, "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        if (!raw || raw.length <= 20) return false;
        let ok = await this._verifyToken(raw);
        if (ok) {
          this.saveData("token", raw);
          return true;
        }
        return false;
      },
    },

    loginWithWebview: {
      url: "https://komiic.com/login",
      checkStatus: (url, title) => {
        if (typeof url !== "string") return false;
        let isKomiic =
          url.indexOf("https://komiic.com") === 0 ||
          url.indexOf("https://komiic.cc") === 0;
        if (!isKomiic) return false;

        // 登录后可能停在喜爱书籍、账户页或首页，不要只匹配 recentUpdate。
        // 只要已经离开登录页，就让 VeneraX 保存 WebView Cookie 并关闭页面。
        let path = url.split("?")[0].split("#")[0].replace(/\/+$/, "");
        return path !== "https://komiic.com/login" &&
          path !== "https://komiic.cc/login";
      },
      onLoginSuccess: async () => {
        let token = await this._loadWebToken();
        if (token) {
          this.saveData("token", token);
        }
      },
    },

    logout: () => {
      this.deleteData("token");
      this.deleteData("account");
      for (let domain of [this.baseUrl, "https://komiic.com", "https://komiic.cc"]) {
        try {
          Network.deleteCookies(domain);
        } catch (e) {}
      }
    },

    registerWebsite: "https://komiic.com/register",
  };

  /// 探索页面
  explore = [
    {
      title: "Komiic",
      type: "multiPageComicList",
      load: async (page) => {
        return await this.queryComics({
          operationName: "recentUpdate",
          variables: {
            pagination: {
              limit: 20,
              offset: (page - 1) * 20,
              orderBy: "DATE_UPDATED",
              status: "",
              asc: true,
            },
          },
          query:
            "query recentUpdate($pagination: Pagination!) {\n  recentUpdate(pagination: $pagination) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
        });
      },
    },
  ];

  category = {
    title: "Komiic",
    enableRankingPage: true,
    parts: [
      {
        name: "主题",
        type: "fixed",
        categories: [
          "全部", "愛情", "神鬼", "校園", "搞笑", "生活", "懸疑", "冒險",
          "職場", "魔幻", "後宮", "魔法", "格鬥", "宅男", "勵志", "耽美",
          "科幻", "百合", "治癒", "萌系", "熱血", "競技", "推理", "雜誌",
          "偵探", "偽娘", "美食", "恐怖", "四格", "社會", "歷史", "戰爭",
          "舞蹈", "武俠", "機戰", "音樂", "體育", "黑道"
        ],
        itemType: "category",
        categoryParams: [
          "0", "1", "3", "4", "5", "6", "7", "8", "10", "11",
          "2", "12", "13", "14", "15", "16", "17", "18", "19", "20",
          "21", "22", "23", "24", "25", "26", "27", "9", "28", "31",
          "32", "33", "34", "35", "36", "37", "40", "42"
        ],
      },
    ],
  };

  categoryComics = {
    load: async (category, param, options, page) => {
      let variables = {
        pagination: {
          limit: 30,
          offset: (page - 1) * 30,
          orderBy: options[0],
          asc: false,
          status: options[1],
        },
      };

      if (param !== "0") {
        variables.categoryId = [param];
      } else {
        variables.categoryId = [];
      }

      return await this.queryComics({
        operationName: "comicByCategories",
        variables: variables,
        query: `query comicByCategories($categoryId: [ID!]!, $pagination: Pagination!) {
                  comicByCategories(categoryId: $categoryId, pagination: $pagination) {
                      id
                      title
                      status
                      year
                      imageUrl
                      authors { id name __typename }
                      categories { id name __typename }
                      dateUpdated
                      monthViews
                      views
                      favoriteCount
                      lastBookUpdate
                      lastChapterUpdate
                      __typename
                  }
              }`,
      });
    },
    optionList: [
      {
        options: ["DATE_UPDATED-更新", "VIEWS-觀看數", "FAVORITE_COUNT-喜愛數"],
        notShowWhen: null,
        showWhen: null,
      },
      {
        options: ["-全部", "ONGOING-連載中", "END-完結"],
        notShowWhen: null,
        showWhen: null,
      },
    ],
    ranking: {
      options: ["MONTH_VIEWS-月", "VIEWS-綜合"],
      load: async (option, page) => {
        return this.queryComics({
          operationName: "hotComics",
          variables: {
            pagination: {
              limit: 20,
              offset: (page - 1) * 20,
              orderBy: option,
              status: "",
              asc: true,
            },
          },
          query:
            "query hotComics($pagination: Pagination!) {\n  hotComics(pagination: $pagination) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
        });
      },
    },
  };

  /// 搜索
  search = {
    load: async (keyword, options, page) => {
      let json = await this.queryJson({
        operationName: "searchComicAndAuthorQuery",
        variables: { keyword: keyword },
        query:
          "query searchComicAndAuthorQuery($keyword: String!) {\n  searchComicsAndAuthors(keyword: $keyword) {\n    comics {\n      id\n      title\n      status\n      year\n      imageUrl\n      authors {\n        id\n        name\n        __typename\n      }\n      categories {\n        id\n        name\n        __typename\n      }\n      dateUpdated\n      monthViews\n      views\n      favoriteCount\n      lastBookUpdate\n      lastChapterUpdate\n      __typename\n    }\n    authors {\n      id\n      name\n      chName\n      enName\n      wikiLink\n      comicCount\n      views\n      __typename\n    }\n    __typename\n  }\n}",
      });

      const fixCover = this._fixCoverUrl.bind(this);

      function parseComic(comic) {
        let author = "";
        if (comic.authors.length > 0) {
          author = comic.authors[0].name;
        }
        let tags = [];
        comic.categories.forEach((c) => {
          tags.push(c.name);
        });

        function getTimeDifference(date) {
          const now = new Date();
          const timeDifference = now - date;

          const millisecondsPerHour = 1000 * 60 * 60;
          const millisecondsPerDay = millisecondsPerHour * 24;

          if (timeDifference < millisecondsPerHour) {
            return "剛剛更新";
          } else if (timeDifference < millisecondsPerDay) {
            const hours = Math.floor(timeDifference / millisecondsPerHour);
            return `${hours}小時前更新`;
          } else {
            const days = Math.floor(timeDifference / millisecondsPerDay);
            return `${days}天前更新`;
          }
        }

        let updateTime = new Date(comic.dateUpdated);
        let description = getTimeDifference(updateTime);

        return {
          id: comic.id,
          title: comic.title,
          subTitle: author,
          cover: fixCover(comic.imageUrl),
          tags: tags,
          description: description,
        };
      }

      return {
        comics: json.data.searchComicsAndAuthors.comics.map(parseComic),
        maxPage: 1,
      };
    },

    optionList: [],
  };

  /// 收藏
  favorites = {
    multiFolder: true,
    addOrDelFavorite: async (comicId, folderId, isAdding) => {
      let query = {};
      if (isAdding) {
        query = {
          operationName: "addComicToFolder",
          variables: { comicId: comicId, folderId: folderId },
          query:
            "mutation addComicToFolder($comicId: ID!, $folderId: ID!) {\n  addComicToFolder(comicId: $comicId, folderId: $folderId)\n}",
        };
      } else {
        query = {
          operationName: "removeComicToFolder",
          variables: { comicId: comicId, folderId: folderId },
          query:
            "mutation removeComicToFolder($comicId: ID!, $folderId: ID!) {\n  removeComicToFolder(comicId: $comicId, folderId: $folderId)\n}",
        };
      }
      await this.queryJson(query);
      return "ok";
    },
    loadFolders: async (comicId) => {
      let json = await this.queryJson({
        operationName: "myFolder",
        variables: {},
        query:
          "query myFolder {\n  folders {\n    id\n    key\n    name\n    views\n    comicCount\n    dateCreated\n    dateUpdated\n    __typename\n  }\n}",
      });
      let folders = {};
      json.data.folders.forEach((f) => {
        folders[f.id] = f.name;
      });
      let favorited = null;
      if (comicId) {
        let json2 = await this.queryJson({
          operationName: "comicInAccountFolders",
          variables: { comicId: comicId },
          query:
            "query comicInAccountFolders($comicId: ID!) {\n  comicInAccountFolders(comicId: $comicId)\n}",
        });
        favorited = json2.data.comicInAccountFolders;
      }
      return {
        folders: folders,
        favorited: favorited,
      };
    },
    addFolder: async (name) => {
      let json = await this.queryJson({
        operationName: "createFolder",
        variables: { name: name },
        query:
          "mutation createFolder($name: String!) {\n  createFolder(name: $name) {\n    id\n    key\n    name\n    account {\n      id\n      nickname\n      __typename\n    }\n    comicCount\n    views\n    dateCreated\n    dateUpdated\n    __typename\n  }\n}",
      });
      return "ok";
    },
    deleteFolder: async (id) => {
      let json = await this.queryJson({
        operationName: "removeFolder",
        variables: { folderId: id },
        query:
          "mutation removeFolder($folderId: ID!) {\n  removeFolder(folderId: $folderId)\n}",
      });
      return "ok";
    },
    loadComics: async (page, folder) => {
      let json = await this.queryJson({
        operationName: "folderComicIds",
        variables: {
          folderId: folder,
          pagination: {
            limit: 30,
            offset: (page - 1) * 30,
            orderBy: "DATE_UPDATED",
            status: "",
            asc: true,
          },
        },
        query:
          "query folderComicIds($folderId: ID!, $pagination: Pagination!) {\n  folderComicIds(folderId: $folderId, pagination: $pagination) {\n    folderId\n    key\n    comicIds\n    __typename\n  }\n}",
      });
      let ids = json.data.folderComicIds.comicIds;
      if (ids.length == 0) {
        return {
          comics: [],
          maxPage: 1,
        };
      }
      return this.queryComics({
        operationName: "comicByIds",
        variables: { comicIds: ids },
        query:
          "query comicByIds($comicIds: [ID]!) {\n  comicByIds(comicIds: $comicIds) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
      });
    },
  };

  _extractKidFromImageUrl(url) {
    if (!url || typeof url !== "string") return null;
    const m = url.match(/^https:\/\/komiic\.(?:com|cc)\/api\/image\/([A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
  }

  _swapKomiicImageHost(url) {
    if (!url || typeof url !== "string") return url;
    if (url.indexOf("https://komiic.com/") === 0) {
      return "https://komiic.cc/" + url.slice("https://komiic.com/".length);
    }
    if (url.indexOf("https://komiic.cc/") === 0) {
      return "https://komiic.com/" + url.slice("https://komiic.cc/".length);
    }
    return url;
  }

  _getImageTicketEntry(key) {
    if (!this._imageTickets || !key) return null;
    return (
      this._imageTickets[key] ||
      this._imageTickets[this._swapKomiicImageHost(key)] ||
      null
    );
  }

  _isTicketEntryStale(entry) {
    if (!entry || typeof entry !== "object" || !entry.ticket) return true;
    if (entry.expiresAt) {
      const expMs = Date.parse(entry.expiresAt);
      if (!isNaN(expMs)) {
        return expMs - Date.now() < 60 * 1000;
      }
    }
    return !entry.fetchedAt || Date.now() - entry.fetchedAt > Komiic.TICKET_REFRESH_TTL_MS;
  }

  _storeTicketEntry(item, epId) {
    if (!item || !item.ticket) return null;
    if (!this._imageTickets) this._imageTickets = {};
    const entry = {
      url: item.url,
      ticket: item.ticket,
      kid: item.kid,
      expiresAt: item.expiresAt || null,
      fetchedAt: Date.now(),
      chapterId: epId || null,
    };
    if (item.kid) {
      this._imageTickets["kid:" + item.kid] = entry;
    }
    if (item.url) {
      this._imageTickets[item.url] = entry;
    }
    return entry;
  }

  _buildImageHeaders(key, refererBase, explicitEntry) {
    const entry = explicitEntry || this._getImageTicketEntry(key);
    const ticket = typeof entry === "string" ? entry : entry?.ticket;
    const token = this.loadData("token");
    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      referer: (refererBase || this.baseUrl) + "/",
    };
    if (ticket) {
      headers["X-Image-Ticket"] = ticket;
    }
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      headers["cookie"] = `komiic-access-token=${token}`;
    }
    return headers;
  }

  async _fetchSingleTicket(kid, epId) {
    if (!kid) return null;
    if (!this._ticketInFlightByKid) this._ticketInFlightByKid = {};
    const cacheKey = "kid:" + kid;
    const existing = this._getImageTicketEntry(cacheKey);
    if (existing && !this._isTicketEntryStale(existing)) {
      return existing;
    }
    if (this._ticketInFlightByKid[kid]) {
      return this._ticketInFlightByKid[kid];
    }
    const task = (async () => {
      const json = await this.queryJson({
        operationName: "getImageTickets",
        variables: { kids: [kid] },
        query:
          "query getImageTickets($kids: [String!]!) {\n  getImageTickets(kids: $kids) {\n    url\n    ticket\n    kid\n    width\n    height\n    expiresAt\n  }\n}",
      });
      const list = json.data?.getImageTickets || [];
      if (list.length > 0) {
        return this._storeTicketEntry(list[0], epId);
      }
      return null;
    })();
    this._ticketInFlightByKid[kid] = task;
    try {
      return await task;
    } finally {
      if (this._ticketInFlightByKid[kid] === task) {
        delete this._ticketInFlightByKid[kid];
      }
    }
  }

  async _refreshSingleTicket(kid, epId) {
    if (!kid) return null;
    if (!this._ticketRefreshByKid) this._ticketRefreshByKid = {};
    if (this._ticketRefreshByKid[kid]) {
      return this._ticketRefreshByKid[kid];
    }
    const task = (async () => {
      try {
        const json = await this.queryJson({
          operationName: "refreshImageTicket",
          variables: { kid: kid },
          query:
            "mutation refreshImageTicket($kid: String!) {\n  refreshImageTicket(kid: $kid) {\n    url\n    ticket\n    kid\n    width\n    height\n    expiresAt\n  }\n}",
        });
        const item = json.data?.refreshImageTicket;
        if (item && item.ticket && item.url) {
          return this._storeTicketEntry(item, epId);
        }
      } catch (e) {}
      return await this._fetchSingleTicket(kid, epId);
    })();
    this._ticketRefreshByKid[kid] = task;
    try {
      return await task;
    } finally {
      if (this._ticketRefreshByKid[kid] === task) {
        delete this._ticketRefreshByKid[kid];
      }
    }
  }

  async _refreshChapterTickets(epId, force = false, bypassCooldown = false) {
    if (!epId) return [];
    if (!this._imageTickets) this._imageTickets = {};
    if (!this._ticketRefreshInFlight) this._ticketRefreshInFlight = {};
    if (!this._ticketLastRefreshedAt) this._ticketLastRefreshedAt = {};
    if (!this._chapterTicketsCache) this._chapterTicketsCache = {};

    if (this._ticketRefreshInFlight[epId]) {
      return this._ticketRefreshInFlight[epId];
    }

    const now = Date.now();
    const lastAt = this._ticketLastRefreshedAt[epId] || 0;
    if (
      !bypassCooldown &&
      now - lastAt < Komiic.TICKET_FORCE_COOLDOWN_MS &&
      this._chapterTicketsCache[epId]
    ) {
      return this._chapterTicketsCache[epId];
    }

    const task = (async () => {
      const json = await this.queryJson({
        operationName: "imageTicketsByChapterId",
        variables: { chapterId: epId },
        query:
          "query imageTicketsByChapterId($chapterId: ID!) {\n  imageTicketsByChapterId(chapterId: $chapterId) {\n    url\n    ticket\n    kid\n    width\n    height\n    expiresAt\n  }\n}",
      });
      const tickets = json.data?.imageTicketsByChapterId || [];
      const fetchedAt = Date.now();
      for (let t of tickets) {
        this._storeTicketEntry(t, epId);
      }
      const cacheKeys = Object.keys(this._chapterTicketsCache);
      if (cacheKeys.length >= 20 && !this._chapterTicketsCache[epId]) {
        delete this._chapterTicketsCache[cacheKeys[0]];
      }
      this._chapterTicketsCache[epId] = tickets;
      this._ticketLastRefreshedAt[epId] = fetchedAt;
      return tickets;
    })();

    this._ticketRefreshInFlight[epId] = task;
    try {
      return await task;
    } finally {
      if (this._ticketRefreshInFlight[epId] === task) {
        delete this._ticketRefreshInFlight[epId];
      }
    }
  }

  /// 单个漫画相关
  comic = {
    loadInfo: async (id) => {
      let json1 = await this.queryJson({
        operationName: "recommendComicById",
        variables: { comicId: id },
        query:
          "query recommendComicById($comicId: ID!) {\n  recommendComicById(comicId: $comicId)\n}",
      });
      let recommend = Array.isArray(json1.data?.recommendComicById)
        ? [...json1.data.recommendComicById]
        : [];
      recommend.push(id);

      let getChapter = async () => {
        let json = await this.queryJson({
          operationName: "chapterByComicId",
          variables: { comicId: id },
          query:
            "query chapterByComicId($comicId: ID!) {\n  chaptersByComicId(comicId: $comicId) {\n    id\n    serial\n    type\n    dateCreated\n    dateUpdated\n    size\n    __typename\n  }\n}",
        });
        let all = json.data.chaptersByComicId;
        let books = [],
          chapters = [];
        all.forEach((c) => {
          if (c.type === "book") {
            books.push(c);
          } else {
            chapters.push(c);
          }
        });
        let res = new Map();
        books.forEach((c) => {
          let name = "卷" + c.serial;
          res.set(c.id, name);
        });
        chapters.forEach((c) => {
          let name = c.serial;
          res.set(c.id, name);
        });
        return res;
      };

      let results = await Promise.all([
        this.queryComics({
          operationName: "comicByIds",
          variables: { comicIds: recommend },
          query:
            "query comicByIds($comicIds: [ID]!) {\n  comicByIds(comicIds: $comicIds) {\n    id\n    title\n    status\n    year\n    imageUrl\n    authors {\n      id\n      name\n      __typename\n    }\n    categories {\n      id\n      name\n      __typename\n    }\n    dateUpdated\n    monthViews\n    views\n    favoriteCount\n    lastBookUpdate\n    lastChapterUpdate\n    __typename\n  }\n}",
        }),
        getChapter.call(),
      ]);

      let info = results[0].comics.pop();

      return {
        title: info.title,
        cover: info.cover,
        tags: {
          作者: [info.subTitle],
          标签: info.tags,
        },
        chapters: results[1],
        recommend: results[0].comics,
        updateTime: info.updateTime,
      };
    },
    loadEp: async (comicId, epId) => {
      // 仅拉取章节图片 kid 列表（imagesByChapterId 不消耗每日图片配额）；
      // 真正浏览或下载单张未缓存图片时才在 onImageLoad 中按页申请票据。
      const json = await this.queryJson({
        operationName: "imagesByChapterId",
        variables: { chapterId: epId },
        query:
          "query imagesByChapterId($chapterId: ID!) {\n  imagesByChapterId(chapterId: $chapterId) {\n    id\n    kid\n    width\n    height\n  }\n}",
      });
      const images = json.data?.imagesByChapterId || [];
      return {
        images: images
          .filter((img) => img && img.kid)
          .map((img) => `https://komiic.com/api/image/${img.kid}`),
      };
    },
    onImageLoad: async (url, comicId, epId) => {
      const kid = this._extractKidFromImageUrl(url);
      if (kid) {
        const cacheKey = "kid:" + kid;
        let entry = this._getImageTicketEntry(cacheKey);
        if (!entry || !entry.ticket || !entry.url) {
          entry = await this._fetchSingleTicket(kid, epId);
        } else if (this._isTicketEntryStale(entry)) {
          // 续期走免费 mutation refreshImageTicket，不重复扣每日配额
          entry = await this._refreshSingleTicket(kid, epId);
        }
        if (!entry || !entry.url) {
          throw "获取 Komiic 图片票据失败";
        }

        let failCount = 0;
        const createKidOnLoadFailed = (currentEntry) => {
          return async () => {
            failCount++;
            if (failCount === 1) {
              const refreshed = await this._refreshSingleTicket(kid, epId);
              const nextEntry = refreshed || currentEntry;
              return {
                url: nextEntry.url,
                headers: this._buildImageHeaders(cacheKey, null, nextEntry),
                onLoadFailed: createKidOnLoadFailed(nextEntry),
              };
            }
            if (failCount === 2 && currentEntry?.url) {
              const altUrl = this._swapKomiicImageHost(currentEntry.url);
              if (altUrl !== currentEntry.url) {
                const altBase =
                  altUrl.indexOf("https://komiic.cc/") === 0
                    ? "https://komiic.cc"
                    : "https://komiic.com";
                return {
                  url: altUrl,
                  headers: this._buildImageHeaders(cacheKey, altBase, currentEntry),
                };
              }
            }
            return null;
          };
        };

        return {
          url: entry.url,
          headers: this._buildImageHeaders(cacheKey, null, entry),
          onLoadFailed: createKidOnLoadFailed(entry),
        };
      }

      // 兼容旧版下载队列中已保存的直链 URL
      const entry = this._getImageTicketEntry(url);
      if (this._isTicketEntryStale(entry) && epId) {
        try {
          if (entry && entry.kid) {
            await this._refreshSingleTicket(entry.kid, epId);
          } else {
            await this._refreshChapterTickets(epId, false, false);
          }
        } catch (e) {}
      }

      let failCount = 0;
      const createOnLoadFailed = () => {
        return async () => {
          failCount++;
          if (failCount === 1) {
            const cur = this._getImageTicketEntry(url);
            if (cur && cur.kid) {
              try {
                await this._refreshSingleTicket(cur.kid, epId);
              } catch (e) {}
            } else if (epId) {
              try {
                await this._refreshChapterTickets(epId, true, false);
              } catch (e) {}
            }
            return {
              url: url,
              headers: this._buildImageHeaders(url),
              onLoadFailed: createOnLoadFailed(),
            };
          }
          if (failCount === 2) {
            const altUrl = this._swapKomiicImageHost(url);
            if (altUrl !== url) {
              const altBase =
                altUrl.indexOf("https://komiic.cc/") === 0
                  ? "https://komiic.cc"
                  : "https://komiic.com";
              return {
                url: altUrl,
                headers: this._buildImageHeaders(url, altBase),
              };
            }
          }
          return null;
        };
      };

      return {
        headers: this._buildImageHeaders(url),
        onLoadFailed: createOnLoadFailed(),
      };
    },
    loadComments: async (comicId, subId, page, replyTo) => {
      const fixCover = this._fixCoverUrl.bind(this);

      let operationName = replyTo ? "messageChan" : "getMessagesByComicId";
      let promise = replyTo
        ? this.queryJson({
            operationName: "messageChan",
            variables: { messageId: replyTo },
            query:
              "query messageChan($messageId: ID!) {\n  messageChan(messageId: $messageId) {\n    id\n    comicId\n    account {\n      id\n      nickname\n      profileText\n      profileTextColor\n      profileBackgroundColor\n      profileImageUrl\n      __typename\n    }\n    message\n    replyTo {\n      id\n      __typename\n    }\n    upCount\n    downCount\n    dateUpdated\n    dateCreated\n    __typename\n  }\n}",
          })
        : this.queryJson({
            operationName: "getMessagesByComicId",
            variables: {
              comicId: comicId,
              pagination: {
                limit: 100,
                offset: (page - 1) * 100,
                orderBy: "DATE_UPDATED",
                asc: true,
              },
            },
            query:
              "query getMessagesByComicId($comicId: ID!, $pagination: Pagination!) {\n  getMessagesByComicId(comicId: $comicId, pagination: $pagination) {\n    id\n    comicId\n    account {\n      id\n      nickname\n      profileText\n      profileTextColor\n      profileBackgroundColor\n      profileImageUrl\n      __typename\n    }\n    message\n    replyTo {\n      id\n      message\n      account {\n        id\n        nickname\n        profileText\n        profileTextColor\n        profileBackgroundColor\n        profileImageUrl\n        __typename\n      }\n      __typename\n    }\n    upCount\n    downCount\n    dateUpdated\n    dateCreated\n    __typename\n  }\n}",
          });
      let json = await promise;
      return {
        comments: json.data[operationName].map((e) => {
          return {
            userName: e.account.nickname,
            avatar: fixCover(e.account.profileImageUrl),
            content: e.message,
            time: e.dateUpdated,
            replyCount: 0,
            id: e.id,
          };
        }),
        maxPage: null,
      };
    },
    sendComment: async (comicId, subId, content, replyTo) => {
      if (!replyTo) {
        replyTo = "0";
      }
      let json = await this.queryJson({
        operationName: "addMessageToComic",
        variables: { comicId: comicId, message: content, replyToId: replyTo },
        query:
          "mutation addMessageToComic($comicId: ID!, $replyToId: ID!, $message: String!) {\n  addMessageToComic(message: $message, comicId: $comicId, replyToId: $replyToId) {\n    id\n    message\n    comicId\n    account {\n      id\n      nickname\n      __typename\n    }\n    replyTo {\n      id\n      message\n      account {\n        id\n        nickname\n        profileText\n        profileTextColor\n        profileBackgroundColor\n        profileImageUrl\n        __typename\n      }\n      __typename\n    }\n    dateCreated\n    dateUpdated\n    __typename\n  }\n}",
      });
      return "ok";
    },
  };

  /// 链接处理
  link = {
    domains: ["komiic.com", "komiic.cc"],
    linkToId: (url) => {
      let match = url.match(/\/comic\/(\d+)/);
      if (match) {
        return match[1];
      }
      return null;
    },
  };

  /// 设置
  settings = {
    domain: {
      title: "访问域名",
      type: "select",
      options: [
        {
          value: "https://komiic.cc",
          text: "中国大陆线路 (komiic.cc，免代理直连推荐)",
        },
        { value: "https://komiic.com", text: "主站 (komiic.com，需海外代理)" },
      ],
      default: "https://komiic.cc",
    },
  };

  // 翻译
  translation = {
    zh_CN: {
      访问域名: "访问域名",
    },
    zh_TW: {
      访问域名: "訪問域名",
    },
    en: {
      访问域名: "Domain",
    },
  };
}
