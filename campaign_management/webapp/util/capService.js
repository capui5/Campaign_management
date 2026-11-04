sap.ui.define([], function () {
	"use strict";

	// OData V4 client for the Campaign & Pricing Management API v1.0 (CAP).
	//   Protocol     OData V4
	//   Base path    /luxasia/oDataV4      (manifest data source "oDataV4")
	//   Destination  LUXASIA_CAP           (xs-app.json route, ui5*.yaml proxy)
	//
	//   ConditionTypes                  key ID                                    GET
	//   ConditionTypeKeyCombinations    key CONDITION_TYPE_ID, KEY_COMBINATION_ID GET, PATCH
	//   Campaigns                       key CampaignId                            GET
	//   CampaignPricingRecords          key ID                                    GET, POST, PATCH, DELETE
	//
	// Plain fetch with JSON bodies (no $batch), so each call maps 1:1 to the API reference. The
	// service URL is taken from the component's "oDataV4" model, so it resolves exactly like the
	// manifest data source. Write requests carry an X-CSRF-Token (fetched once, refetched when the
	// server answers 403 "Required"). Every call returns a Promise; errors are Error objects with
	// .messages = [{ type, text, field }] and .statusCode, like the other services of this app.

	var _oComponent = null;
	var _sBase = "";
	var _pToken = null;
	var _pUser = null;

	// ---------------------------------------------------------------- messages

	function _err(sText, sField) {
		return { type: "Error", text: sText, field: sField || "" };
	}

	function _throw(aMsg, iStatus) {
		var aList = Array.isArray(aMsg) ? aMsg : [aMsg];
		var oErr = new Error(aList[0].text);
		oErr.messages = aList;
		oErr.statusCode = iStatus ? String(iStatus) : "";
		return oErr;
	}

	// OData V4 error body: { error: { code, message, target, details: [{ message, target }] } }.
	function _fromResponse(oResponse, sText) {
		var aMsg = [];
		try {
			var oBody = JSON.parse(sText).error || {};
			var sMain = typeof oBody.message === "object" ? oBody.message.value : oBody.message;
			if (sMain) {
				aMsg.push(_err(sMain, oBody.target));
			}
			(oBody.details || []).forEach(function (d) {
				if (d.message && d.message !== sMain && d["@Common.numericSeverity"] !== 1) {
					aMsg.push(_err(d.message, d.target));
				}
			});
		} catch (e) {
			// not an OData JSON error body
		}
		if (!aMsg.length) {
			aMsg.push(_err("Request failed: " + oResponse.status + " " + (oResponse.statusText || "")));
		}
		return _throw(aMsg, oResponse.status);
	}

	// ---------------------------------------------------------------- transport

	function _base() {
		if (!_sBase) {
			throw _throw(_err("The campaign pricing service is not initialized."));
		}
		return _sBase;
	}

	// Paths are relative to the service root; absolute URLs (e.g. @odata.nextLink) pass through.
	function _url(sPath, mQuery) {
		var sUrl = /^(https?:)?\//.test(sPath) ? sPath : _base() + sPath;
		var aParts = Object.keys(mQuery || {}).filter(function (k) {
			return mQuery[k] !== undefined && mQuery[k] !== null && mQuery[k] !== "";
		}).map(function (k) {
			return k + "=" + encodeURIComponent(String(mQuery[k]));
		});
		return aParts.length ? sUrl + (sUrl.indexOf("?") === -1 ? "?" : "&") + aParts.join("&") : sUrl;
	}

	function _token() {
		if (!_pToken) {
			_pToken = fetch(_base(), {
				method: "GET",
				headers: { "X-CSRF-Token": "Fetch", Accept: "application/json" },
				credentials: "same-origin"
			}).then(function (oResponse) {
				return oResponse.headers.get("X-CSRF-Token") || "";
			}).catch(function () {
				_pToken = null;
				return "";
			});
		}
		return _pToken;
	}

	function _request(sMethod, sPath, mQuery, oBody, bRetried) {
		var bWrite = sMethod !== "GET";
		var sUrl;
		try {
			sUrl = _url(sPath, mQuery);
		} catch (e) {
			return Promise.reject(e);
		}
		return (bWrite ? _token() : Promise.resolve("")).then(function (sToken) {
			var mHeaders = { Accept: "application/json" };
			if (oBody !== undefined) {
				mHeaders["Content-Type"] = "application/json";
			}
			if (sToken) {
				mHeaders["X-CSRF-Token"] = sToken;
			}
			if (sMethod === "POST" || sMethod === "PATCH") {
				mHeaders.Prefer = "return=representation";
			}
			return fetch(sUrl, {
				method: sMethod,
				headers: mHeaders,
				credentials: "same-origin",
				body: oBody !== undefined ? JSON.stringify(oBody) : undefined
			});
		}).then(function (oResponse) {
			if (bWrite && !bRetried && oResponse.status === 403 &&
				/required/i.test(oResponse.headers.get("X-CSRF-Token") || "")) {
				_pToken = null;
				return _request(sMethod, sPath, mQuery, oBody, true);
			}
			return oResponse.text().then(function (sText) {
				if (!oResponse.ok) {
					throw _fromResponse(oResponse, sText);
				}
				return sText ? JSON.parse(sText) : null;
			});
		}, function (oError) {
			// network failure / destination not reachable
			throw oError && oError.messages ? oError : _throw(_err("The campaign pricing service (" + _sBase +
				") cannot be reached: " + ((oError && oError.message) || "network error") + "."));
		});
	}

	// ---------------------------------------------------------------- public API

	return {
		// Resolves the service URL once from the component's "oDataV4" model / data source.
		init: function (oComponent) {
			_oComponent = oComponent;
			if (!_sBase) {
				var oModel = oComponent.getModel("oDataV4");
				var sUrl = (oModel && oModel.getServiceUrl && oModel.getServiceUrl()) ||
					oComponent.getManifestEntry("/sap.app/dataSources/oDataV4/uri") || "/luxasia/oDataV4/";
				_sBase = sUrl.replace(/\/?$/, "/");
			}
		},

		// OData string literal: 'O''Brien'.
		literal: function (s) {
			return "'" + String(s === undefined || s === null ? "" : s).replace(/'/g, "''") + "'";
		},

		// GET a single entity or a collection body as returned.
		get: function (sPath, mQuery) {
			return _request("GET", sPath, mQuery);
		},

		// GET a collection; resolves with the value array (follows @odata.nextLink).
		list: function (sPath, mQuery) {
			var aAll = [];
			function next(sUrl, mQ) {
				return _request("GET", sUrl, mQ).then(function (oData) {
					aAll = aAll.concat((oData && oData.value) || []);
					var sNext = oData && oData["@odata.nextLink"];
					return sNext ? next(sNext) : aAll;
				});
			}
			return next(sPath, mQuery);
		},

		// GET one page of a collection ($count=true&$top=n&$skip=m, API §4.1); resolves with
		// { value, count } (count from @odata.count, else the rows read so far).
		listPage: function (sPath, mQuery, iTop, iSkip) {
			return _request("GET", sPath, Object.assign({}, mQuery, { $count: true, $top: iTop, $skip: iSkip })).then(function (oData) {
				var aPage = (oData && oData.value) || [];
				var iCount = oData && oData["@odata.count"] !== undefined ? Number(oData["@odata.count"]) : NaN;
				return { value: aPage, count: isNaN(iCount) ? iSkip + aPage.length : iCount };
			});
		},

		// GET a collection page by page ($count=true&$top=n&$skip=m, API §4.1) until all rows
		// counted by the server are read; resolves with { value, count }.
		listPaged: function (sPath, mQuery, iPageSize) {
			var iTop = iPageSize || 200;
			var aAll = [];
			function page(iSkip) {
				return _request("GET", sPath, Object.assign({}, mQuery, { $count: true, $top: iTop, $skip: iSkip })).then(function (oData) {
					var aPage = (oData && oData.value) || [];
					var iCount = oData && oData["@odata.count"] !== undefined ? Number(oData["@odata.count"]) : NaN;
					aAll = aAll.concat(aPage);
					if (!aPage.length || (!isNaN(iCount) && aAll.length >= iCount) || (isNaN(iCount) && aPage.length < iTop)) {
						return { value: aAll, count: isNaN(iCount) ? aAll.length : iCount };
					}
					return page(iSkip + aPage.length);
				});
			}
			return page(0);
		},

		create: function (sSet, oBody) {
			return _request("POST", sSet, null, oBody);
		},

		update: function (sPath, oBody) {
			return _request("PATCH", sPath, null, oBody);
		},

		remove: function (sPath) {
			return _request("DELETE", sPath);
		},

		// Client-generated key for POST (API §5.2 sends the ID in the body).
		uuid: function () {
			if (window.crypto && typeof window.crypto.randomUUID === "function") {
				return window.crypto.randomUUID();
			}
			var a = new Uint8Array(16);
			window.crypto.getRandomValues(a);
			a[6] = (a[6] & 0x0f) | 0x40;
			a[8] = (a[8] & 0x3f) | 0x80;
			var s = Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
			return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20);
		},

		// Logged-in user (approuter user API) for CREATED_BY; "" when it cannot be read.
		userName: function () {
			if (!_pUser) {
				if (!_oComponent) {
					return Promise.resolve("");
				}
				var sUrl = sap.ui.require.toUrl(_oComponent.getManifestEntry("/sap.app/id").replace(/\./g, "/")) + "/user-api/attributes";
				_pUser = fetch(sUrl, { credentials: "same-origin" }).then(function (oResponse) {
					return oResponse.ok ? oResponse.json() : {};
				}).then(function (oUser) {
					return String(oUser.name || (oUser.email || "").split("@")[0] || "").toUpperCase();
				}).catch(function () {
					return "";
				});
			}
			return _pUser;
		},

		// Test hook.
		_reset: function () {
			_oComponent = null;
			_sBase = "";
			_pToken = null;
			_pUser = null;
		}
	};
});
