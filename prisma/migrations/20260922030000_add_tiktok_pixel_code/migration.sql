-- AddTikTokPixelCode: ADMIN-managed TikTok Pixel base code + pixel name.
--
-- Non-destructive: only adds two NULLABLE columns, so existing rows stay
-- valid and nothing is rewritten unless the backfill below matches.
--
-- `tiktokPixelCode` stores the (trusted, ADMIN-only) base code that the
-- storefront executes. The database stores configuration, the application
-- stores the rendering mechanism.

ALTER TABLE `storesetting`
  ADD COLUMN `tiktokPixelName` VARCHAR(191) NULL,
  ADD COLUMN `tiktokPixelCode` TEXT NULL;

-- Backfill.
--
-- Before this migration the storefront injected a built-in TikTok base code
-- whenever `tiktokPixelId` was set. To keep tracking running (and to give the
-- admin an editable starting point) the equivalent base code is written into
-- the new column, with the store's own Pixel ID.
--
-- Only rows that have a Pixel ID and no code yet are touched; an existing
-- code is never overwritten.
UPDATE `storesetting`
SET `tiktokPixelCode` = CONCAT(
    '<script>\n',
    '!function (w, d, t) {\n',
    '  w.TiktokAnalyticsObject = t;\n',
    '  var ttq = w[t] = w[t] || [];\n',
    '  ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];\n',
    '  ttq.setAndDefer = function (t, e) {\n',
    '    t[e] = function () {\n',
    '      t.push([e].concat(Array.prototype.slice.call(arguments, 0)));\n',
    '    };\n',
    '  };\n',
    '  for (var i = 0; i < ttq.methods.length; i++) {\n',
    '    ttq.setAndDefer(ttq, ttq.methods[i]);\n',
    '  }\n',
    '  ttq.instance = function (t) {\n',
    '    for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) {\n',
    '      ttq.setAndDefer(e, ttq.methods[n]);\n',
    '    }\n',
    '    return e;\n',
    '  };\n',
    '  ttq.load = function (e, n) {\n',
    '    var r = "https://analytics.tiktok.com/i18n/pixel/events.js";\n',
    '    var o = n && n.partner;\n',
    '    ttq._i = ttq._i || {};\n',
    '    ttq._i[e] = [];\n',
    '    ttq._i[e]._u = r;\n',
    '    ttq._t = ttq._t || {};\n',
    '    ttq._t[e] = +new Date();\n',
    '    ttq._o = ttq._o || {};\n',
    '    ttq._o[e] = n || {};\n',
    '    var a = d.createElement("script");\n',
    '    a.type = "text/javascript";\n',
    '    a.async = true;\n',
    '    a.src = r + "?sdkid=" + e + "&lib=" + t;\n',
    '    var s = d.getElementsByTagName("script")[0];\n',
    '    s.parentNode.insertBefore(a, s);\n',
    '  };\n',
    '  ttq.load("', `tiktokPixelId`, '");\n',
    '  ttq.page();\n',
    '  w.dispatchEvent(\n',
    '    new Event("tiktok-pixel-ready")\n',
    '  );\n',
    '}(window, document, "ttq");\n',
    '</script>'
)
WHERE `tiktokPixelId` IS NOT NULL
  AND TRIM(`tiktokPixelId`) <> ''
  AND (`tiktokPixelCode` IS NULL OR `tiktokPixelCode` = '');
