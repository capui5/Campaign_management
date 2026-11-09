sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"com/luxasia/campaignmanagement/util/capService"
], function (JSONModel, capService) {
	"use strict";

	// Campaign pricing conditions + Axxx key configuration facade (Campaign Management FDD/TDD v1.1,
	// §3, §4.2, §5 "Pricing tab", §12, §13, §19 - §21; Campaign & Pricing Management API v1.0).
	//
	// The UI talks only to this module; every public method that calls the backend returns a Promise.
	//
	// Backend 1: CAP service /luxasia/oDataV4 (capService, destination LUXASIA_CAP):
	//   ConditionTypes?$filter=IS_ACTIVE eq true                         condition types (API §2.1):
	//                                                                    code, description, LEVEL,
	//                                                                    VALUE_KIND (PRICE/AMOUNT/PERCENT)
	//   ConditionTypeKeyCombinations?$expand=CONDITION_TYPE,             full configuration matrix
	//     KEY_COMBINATION                                                (API §3.2)
	//   ConditionTypeKeyCombinations?$filter=CONDITION_TYPE_ID eq <ID>   mappings of one condition type
	//     and IS_ACTIVE eq true&$expand=KEY_COMBINATION(                 with the business keys of each
	//     $expand=BUSINESS_KEYS)                                         combination (API §3.1); read
	//                                                                    per active type on init (key
	//                                                                    fields, DIST_CHANNEL default)
	//   PATCH ConditionTypeKeyCombinations(CONDITION_TYPE_ID=..,         table number / default / active
	//     KEY_COMBINATION_ID=..)                                         (API §3.3)
	//   CampaignPricingRecords?$filter=CAMPAIGN_ID eq '..'               the campaign's records (API §5.1)
	//     &$expand=CONDITION_TYPE,KEY_COMBINATION
	//   POST CampaignPricingRecords                                      new record, STATUS DRAFT (§5.2)
	//   PATCH CampaignPricingRecords('<ID>')                             STATUS POSTED + RECORD_NUMBER, or
	//                                                                    STATUS FAILED + ERROR_MESSAGE
	//                                                                    after the S/4 post (§5.3, §5.4)
	//   DELETE CampaignPricingRecords('<ID>')                            remove a draft / failed record (§5.5)
	//
	// Backend 2: S/4 standard API API_SLSPRICINGCONDITIONRECORD_SRV (model of the same name), used
	// only by save() ("Save to S/4"):
	//   POST A_SlsPrcgConditionRecord   deep insert of the condition record with one
	//                                   to_SlsPrcgCndnRecdValidity entry; returns ConditionRecord (KNUMH).
	//   The validity key properties follow the business keys of the record's key combination
	//   (BUSINESS_KEYS.S4_FIELD, see S4_KEY_PROPERTY), so every condition table gets only its own keys.
	//
	// Value helps (CAP, read only):
	//   SalesOrganizations    SALES_ORG                                   loaded once
	//   BrandsMaster          BRAND, DESCRIPTION, LANGUAGE                loaded once
	//   Customers             CUSTOMER, CUSTOMER_NAME, CITY, COUNTRY      loaded once
	//   Articles              ARTICLE_SKU, DESCRIPTION, SPRAS             loaded once
	//   Currencies            CURRENCY                                    loaded once
	//   UnitsOfMeasure        UNIT_OF_MEASURE, DESCRIPTION                loaded once
	//
	// S/4 is written only by save(); drafts, deletions and the configuration go to CAP only.
	//
	// Condition types, key combinations and business keys come only from the CAP service. When it
	// cannot be reached the catalogue stays empty ("available.config" / "available.records" false) and
	// the service error is published in /serviceError.

	var TYPE_SET = "ConditionTypes";
	var TYPE_COMB_SET = "ConditionTypeKeyCombinations";
	var RECORD_SET = "CampaignPricingRecords";

	var S4_MODEL = "API_SLSPRICINGCONDITIONRECORD_SRV";
	var S4_CONDITION_SET = "/A_SlsPrcgConditionRecord";
	var S4_VALIDITY_TYPE = "A_SlsPrcgCndnRecdValidityType";
	var S4_APPLICATION = "V"; // sales
	// Header defaults of the S/4 deep insert, used when the row does not carry its own value
	// (no configured condition table, percentage types without currency / quantity).
	var S4_DEFAULT_TABLE = "949";
	var S4_DEFAULT_CURRENCY = "EUR";
	var S4_DEFAULT_QUANTITY = "1";
	var S4_DEFAULT_QUANTITY_UNIT = "PC";
	// Property order of the validity entry in the payload.
	var S4_VALIDITY_ORDER = ["ConditionValidityStartDate", "ConditionValidityEndDate", "SalesOrganization",
		"DistributionChannel", "Customer", "Material", "ZZCAMPAIGN"];
	var SALES_ORG_SET = "SalesOrganizations";
	var BRAND_SET = "BrandsMaster";
	var CUSTOMER_SET = "Customers";
	var ARTICLE_SET = "Articles";
	var CURRENCY_SET = "Currencies";
	var UOM_SET = "UnitsOfMeasure";
	var VALUE_HELP_LIMIT = 5000; // entries per dropdown (the views bind with length: 5000)

	// Row property -> CampaignPricingRecords property (API §5).
	var FIELD = {
		rowId: "ID",
		campaignId: "CAMPAIGN_ID",
		conditionType: "CONDITION_CODE",       // KSCHL
		combination: "COMBINATION_CODE",
		salesOrg: "SALES_ORG",                 // VKORG
		distChannel: "DISTRIBUTION_CHANNEL",   // VTWEG
		customer: "CUSTOMER",                  // KUNNR
		article: "ARTICLE_SKU",                // MATNR
		brand: "BRAND",
		hierarchy: "HIERARCHY",
		validFrom: "VALID_FROM",               // Edm.Date YYYY-MM-DD
		validTo: "VALID_TO",
		rate: "CONDITION_VALUE",               // KBETR
		rateUnit: "CURRENCY",                  // KONWA (empty for percentages)
		pricingUnit: "PRICING_UNIT",           // KPEIN (price kind)
		uom: "UNIT_OF_MEASURE",                // KMEIN (price kind)
		status: "STATUS",
		recordNo: "RECORD_NUMBER",             // KNUMH
		tableNo: "CONDITION_TABLE_NUMBER",     // KOTABNR snapshot (§22)
		message: "ERROR_MESSAGE",
		createdBy: "CREATED_BY",
		createdOn: "CREATED_AT",
		changedBy: "MODIFIED_BY",
		changedOn: "MODIFIED_AT"
	};

	// CampaignPricingRecords.STATUS values.
	var RECORD_STATUS = {
		DRAFT: "DRAFT",
		POSTED: "POSTED",
		FAILED: "FAILED"
	};

	// Business key -> property of to_SlsPrcgCndnRecdValidity. Looked up by BUSINESS_KEYS.S4_FIELD
	// first, then by FIELD_CODE. An S4_FIELD that already is a validity property name (e.g.
	// ProdUnivHierarchyNode) is used as it is, so new key fields need configuration only, no code.
	var S4_KEY_PROPERTY = {
		VKORG: "SalesOrganization",
		SALES_ORG: "SalesOrganization",
		VTWEG: "DistributionChannel",
		DIST_CHANNEL: "DistributionChannel",
		CAMPAIGN: "ZZCAMPAIGN",
		ZZCAMPAIGN: "ZZCAMPAIGN",
		KUNNR: "Customer",
		CUSTOMER: "Customer",
		MATNR: "Material",
		ARTICLE: "Material",
		ARTICLE_SKU: "Material"
	};

	// BUSINESS_KEYS.FIELD_CODE spellings -> the code used below. The CAP service sends
	// DISTRIBUTION_CHANNEL, the API document DIST_CHANNEL.
	var KEY_ALIAS = {
		DISTRIBUTION_CHANNEL: "DIST_CHANNEL",
		DISTR_CHANNEL: "DIST_CHANNEL",
		VTWEG: "DIST_CHANNEL",
		SALES_ORGANIZATION: "SALES_ORG",
		CAMPAIGN_ID: "CAMPAIGN",
		CUSTOMER_NUMBER: "CUSTOMER"
	};

	function _keyCode(sFieldCode) {
		var sCode = String(sFieldCode || "").trim().toUpperCase();
		return KEY_ALIAS[sCode] || sCode;
	}

	// BUSINESS_KEYS.FIELD_CODE (normalized by _keyCode) -> row property holding its value.
	var KEY_VALUE = {
		SALES_ORG: "salesOrg",
		DIST_CHANNEL: "distChannel",
		CAMPAIGN: "campaignId",
		CUSTOMER: "customer",
		ARTICLE: "article",
		ARTICLE_SKU: "article",
		BRAND: "brand",
		HIERARCHY: "hierarchy"
	};

	// BUSINESS_KEYS.FIELD_CODE -> logical key field of a row. SALES_ORG, DIST_CHANNEL and CAMPAIGN are
	// part of every combination; HIERARCHY comes with BRAND.
	var KEY_FIELD = {
		CUSTOMER: "customer",
		ARTICLE: "article",
		ARTICLE_SKU: "article",
		BRAND: "brand"
	};

	// ConditionTypes.VALUE_KIND -> kind: price = amount + currency + pricing unit; amount = amount +
	// currency; percent = percentage.
	var VALUE_KIND = {
		PRICE: "price",
		AMOUNT: "amount",
		PERCENT: "percent"
	};

	var PERCENT = "%";

	// Condition currency proposed from the campaign country (Luxasia markets, see campaignService).
	var COUNTRY_CURRENCY = {
		SG: "SGD", MY: "MYR", TH: "THB", PH: "PHP", VN: "VND", ID: "IDR",
		IN: "INR", AU: "AUD", HK: "HKD", TW: "TWD", CN: "CNY"
	};

	// Row status shown in the UI. Draft / Posted / Failed mirror CampaignPricingRecords.STATUS;
	// Error is a client-side validation result and is never stored.
	var STATUS = {
		DRAFT: "Draft",
		ERROR: "Error",
		POSTED: "Posted",
		FAILED: "Failed"
	};

	var STATUS_STATE = {
		"Draft": "Information",
		"Error": "Error",
		"Posted": "Success",
		"Failed": "Error"
	};

	// Save state of a configuration entry in the CAP service.
	var VALIDATION = {
		LOCAL: "Local",       // fallback catalogue, not stored anywhere
		SAVED: "Saved",       // as read from / last saved to the service
		CHANGED: "Changed",   // edited here, not saved yet
		FAILED: "Failed"      // last PATCH rejected
	};

	var _oComponent = null;
	var _oModel = null;
	var _pInit = null;
	var _bFreshCatalog = false; // catalogue just read by init(); the next reloadCatalog() skips
	var _pValueHelps = null;
	var _iRowSeq = 0;
	var _mAvailable = { config: false, records: false, posting: false };
	var _aValidityProps = []; // property names of to_SlsPrcgCndnRecdValidity

	// Catalogue: condition types and key combinations, from CAP only.
	var _mTypes = {};     // code -> { id, code, description, level, kind }
	var _aTypeOrder = []; // codes in display order
	var _mCombs = {};     // code -> { id, code, description, active, fields, keys }

	// ---------------------------------------------------------------- messages

	function _throw(aMsg) {
		var aList = Array.isArray(aMsg) ? aMsg : [aMsg];
		var oErr = new Error(aList[0].text);
		oErr.messages = aList;
		return oErr;
	}

	function _err(sText, sField) {
		return { type: "Error", text: sText, field: sField || "" };
	}

	// ---------------------------------------------------------------- value helps (CAP)

	// [{ key, text }] without duplicates (e.g. one row per language), first row wins.
	function _uniqueItems(aRows, fnKey, fnText, fnExtra) {
		var mSeen = {};
		return aRows.filter(function (r) {
			var sKey = fnKey(r);
			var bNew = !!sKey && !mSeen[sKey];
			mSeen[sKey] = true;
			return bNew;
		}).map(function (r) {
			var oItem = { key: fnKey(r), text: fnText(r) || fnKey(r) };
			if (fnExtra) {
				oItem.info = fnExtra(r) || "";
			}
			return oItem;
		});
	}

	// Rows in the logon language first, so _uniqueItems keeps that description.
	function _byLanguage(aRows, sProp) {
		return aRows.slice().sort(function (a, b) {
			return (a[sProp] === "E" ? 0 : 1) - (b[sProp] === "E" ? 0 : 1);
		});
	}

	// List name -> CAP entity set and the mapping to dropdown items { key, text, info }.
	var VALUE_HELPS = {
		salesOrgs: {
			set: SALES_ORG_SET,
			items: function (aRows) {
				return _uniqueItems(aRows, function (r) { return r.SALES_ORG; }, function () { return ""; });
			}
		},
		brands: {
			set: BRAND_SET,
			items: function (aRows) {
				return _uniqueItems(_byLanguage(aRows, "LANGUAGE"), function (r) { return r.BRAND; },
					function (r) { return r.DESCRIPTION; });
			}
		},
		customers: {
			set: CUSTOMER_SET,
			items: function (aRows) {
				return _uniqueItems(aRows, function (r) { return r.CUSTOMER; }, function (r) { return r.CUSTOMER_NAME; },
					function (r) { return [r.CITY, r.COUNTRY].filter(Boolean).join(", "); });
			}
		},
		articles: {
			set: ARTICLE_SET,
			items: function (aRows) {
				return _uniqueItems(_byLanguage(aRows, "SPRAS"), function (r) { return r.ARTICLE_SKU; },
					function (r) { return r.DESCRIPTION; });
			}
		},
		currencies: {
			set: CURRENCY_SET,
			items: function (aRows) {
				return _uniqueItems(aRows, function (r) { return r.CURRENCY; }, function () { return ""; });
			}
		},
		uoms: {
			set: UOM_SET,
			items: function (aRows) {
				return _uniqueItems(aRows, function (r) { return r.UNIT_OF_MEASURE; }, function (r) { return r.DESCRIPTION; });
			}
		}
	};

	// SAP Gateway (V2) error body -> messages (same parsing as campaignService).
	function _fromODataError(oError) {
		var aMsg = [];
		try {
			var oBody = JSON.parse(oError.responseText).error;
			((oBody.innererror && oBody.innererror.errordetails) || []).forEach(function (d) {
				// skip the generic Gateway wrappers ("Exception raised without specific error", ...)
				if (d.severity !== "info" && !/^\/IWBEP\/CX_MGW_/.test(d.code || "")) {
					aMsg.push(_err(d.message, d.target));
				}
			});
			if (!aMsg.length && oBody.message) {
				aMsg.push(_err(oBody.message.value || oBody.message));
			}
		} catch (e) {
			// not a Gateway JSON body
		}
		if (!aMsg.length) {
			aMsg.push(_err((oError && (oError.message || oError.statusText)) || "Request failed."));
		}
		return _throw(aMsg);
	}

	// ---------------------------------------------------------------- S/4 (V2) calls

	function _s4() {
		return _oComponent.getModel(S4_MODEL);
	}

	function _post(sSet, oPayload) {
		return new Promise(function (resolve, reject) {
			_s4().create(sSet, oPayload, {
				success: function (oData) { resolve(oData || {}); },
				error: function (oError) { reject(_fromODataError(oError)); }
			});
		});
	}

	// Whether the S/4 pricing API is reachable; also reads the validity properties (key fields).
	function _detectPosting() {
		var oMetaModel = _s4() && _s4().getMetaModel();
		if (!oMetaModel) {
			_mAvailable.posting = false;
			return Promise.resolve();
		}
		return oMetaModel.loaded().then(function () {
			var oContainer = oMetaModel.getODataEntityContainer() || {};
			_mAvailable.posting = (oContainer.entitySet || []).some(function (s) { return "/" + s.name === S4_CONDITION_SET; });
			var oType = oMetaModel.getODataEntityType(oContainer.namespace + "." + S4_VALIDITY_TYPE) ||
				((oMetaModel.getServiceMetadata().dataServices.schema || []).reduce(function (aAll, oSchema) {
					return aAll.concat(oSchema.entityType || []);
				}, []).find(function (t) { return t.name === S4_VALIDITY_TYPE; }));
			_aValidityProps = ((oType && oType.property) || []).map(function (p) { return p.name; });
		}).catch(function () {
			_mAvailable.posting = false;
		});
	}

	// ---------------------------------------------------------------- dates / numbers

	function _day(d) {
		return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
	}

	function _pad(n) {
		return String(n).padStart(2, "0");
	}

	// Edm.Date
	function _toIsoDate(d) {
		return d ? d.getFullYear() + "-" + _pad(d.getMonth() + 1) + "-" + _pad(d.getDate()) : null;
	}

	function _parseDate(v) {
		if (v instanceof Date) {
			return _day(v);
		}
		var a = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v || "");
		if (a) {
			return a[1] === "0000" ? null : new Date(+a[1], +a[2] - 1, +a[3]);
		}
		var aMs = /^\/Date\((-?\d+)/.exec(v || "");
		if (aMs) {
			var oUtc = new Date(+aMs[1]);
			return new Date(oUtc.getUTCFullYear(), oUtc.getUTCMonth(), oUtc.getUTCDate());
		}
		return null;
	}

	// Edm.Decimal arrives as a number (or a string with IEEE754Compatible); 1.000 -> "1".
	function _numText(v) {
		if (v === undefined || v === null || v === "") {
			return "";
		}
		var n = Number(v);
		return isNaN(n) ? String(v) : String(n);
	}

	function _num(s) {
		var sTrim = String(s === undefined || s === null ? "" : s).trim();
		return sTrim === "" ? null : Number(sTrim);
	}

	// ---------------------------------------------------------------- catalogue

	function _fieldsFromKeys(aKeys) {
		var aFields = [];
		aKeys.forEach(function (k) {
			var sField = KEY_FIELD[k.code];
			if (sField && aFields.indexOf(sField) === -1) {
				aFields.push(sField);
			}
		});
		return aFields;
	}

	function _combFromBackend(o) {
		var aKeys = (o.BUSINESS_KEYS || []).slice().sort(function (a, b) {
			return (a.SEQUENCE || 0) - (b.SEQUENCE || 0);
		}).map(function (k) {
			return {
				field: k.FIELD_CODE,
				code: _keyCode(k.FIELD_CODE),
				label: k.BUSINESS_KEY || k.FIELD_CODE,
				s4Field: k.S4_FIELD || "",
				sequence: k.SEQUENCE,
				required: !!k.REQUIRED,
				defaultValue: k.DEFAULT_VALUE || ""
			};
		});
		return {
			id: o.ID,
			code: o.COMBINATION_CODE,
			description: o.DESCRIPTION || "",
			active: o.IS_ACTIVE !== false,
			fields: _fieldsFromKeys(aKeys),
			keys: aKeys
		};
	}

	// Condition types in the order the service returns them.
	function _typeRank(sCode) {
		var i = _aTypeOrder.indexOf(sCode);
		return i === -1 ? _aTypeOrder.length : i;
	}

	function _sortConfigs(aConfigs) {
		return aConfigs.sort(function (a, b) {
			return (_typeRank(a.conditionType) - _typeRank(b.conditionType)) ||
				a.conditionType.localeCompare(b.conditionType) || a.combination.localeCompare(b.combination);
		});
	}

	// No catalogue: used until CAP has answered, and when it cannot be read.
	function _clearCatalog() {
		_mTypes = {};
		_mCombs = {};
		_aTypeOrder = [];
		_oModel.setProperty("/configs", []);
	}

	function _configFromBackend(r, oComb) {
		return {
			conditionTypeId: r.CONDITION_TYPE_ID,
			combinationId: r.KEY_COMBINATION_ID,
			conditionType: (r.CONDITION_TYPE || {}).CONDITION_CODE,
			combination: oComb.code,
			fieldSet: oComb.description,
			tableNo: r.CONDITION_TABLE_NUMBER === "TBD" ? "" : (r.CONDITION_TABLE_NUMBER || ""),
			active: !!r.IS_ACTIVE,
			isDefault: !!r.DEFAULT_FLAG,
			validation: VALIDATION.SAVED,
			dirty: false
		};
	}

	// Active condition types (API §2.1) + the full configuration matrix with business keys (§3.1 /
	// §3.2). Mappings of inactive condition types are not shown.
	function _applyCatalog(aTypes, aRows) {
		_mTypes = {};
		_mCombs = {};
		aTypes.forEach(function (t) {
			var sCode = String(t.CONDITION_CODE || "").trim().toUpperCase();
			if (sCode) {
				_mTypes[sCode] = {
					id: t.ID,
					code: sCode,
					description: t.DESCRIPTION || "",
					level: String(t.LEVEL || "").toLowerCase(),
					kind: VALUE_KIND[String(t.VALUE_KIND || "").toUpperCase()] || "amount"
				};
			}
		});
		_aTypeOrder = Object.keys(_mTypes);
		var aConfigs = [];
		aRows.forEach(function (r) {
			var sType = String((r.CONDITION_TYPE || {}).CONDITION_CODE || "").trim().toUpperCase();
			var oCombData = r.KEY_COMBINATION || {};
			if (!_mTypes[sType] || !oCombData.COMBINATION_CODE) {
				return;
			}
			if (!_mCombs[oCombData.COMBINATION_CODE]) {
				_mCombs[oCombData.COMBINATION_CODE] = _combFromBackend(oCombData);
			}
			var oConfig = _configFromBackend(r, _mCombs[oCombData.COMBINATION_CODE]);
			oConfig.conditionType = sType;
			aConfigs.push(oConfig);
		});
		_oModel.setProperty("/configs", _sortConfigs(aConfigs));
	}

	function _configsOf(sType) {
		return _configs().filter(function (c) { return c.conditionType === sType; });
	}

	// API §3.1: active mappings of one condition type with the business keys of their combinations
	// (BUSINESS_KEYS: key fields, DIST_CHANNEL DEFAULT_VALUE, S/4 fields). Merged into the matrix of
	// §3.2 (inactive mappings stay as read there); entries edited here and not saved yet are kept.
	// CONDITION_TYPE is the navigation property to ConditionTypes (via the Guid CONDITION_TYPE_ID), so
	// the API document's "CONDITION_TYPE eq 'ZSRP'" compares an association with a string and CAP
	// answers 500. The type is filtered by its foreign key (ID from §2.1) instead, else by its code
	// through the navigation path.
	function _typeFilter(sType) {
		var sId = String((_mTypes[sType] || {}).id || "");
		return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sId) ?
			"CONDITION_TYPE_ID eq " + sId : "CONDITION_TYPE/CONDITION_CODE eq " + capService.literal(sType);
	}

	function _loadConfigsFor(sType) {
		return capService.list(TYPE_COMB_SET, {
			$filter: _typeFilter(sType) + " and IS_ACTIVE eq true",
			$expand: "KEY_COMBINATION($expand=BUSINESS_KEYS)"
		}).then(function (aRows) {
			var aConfigs = _configs();
			aRows.forEach(function (r) {
				var oCombData = r.KEY_COMBINATION || {};
				if (!oCombData.COMBINATION_CODE) {
					return;
				}
				var oComb = _combFromBackend(oCombData);
				_mCombs[oComb.code] = oComb;
				var oFresh = _configFromBackend(r, oComb);
				oFresh.conditionType = sType;
				var i = aConfigs.findIndex(function (c) {
					return c.conditionType === sType && c.combination === oComb.code;
				});
				if (i === -1) {
					aConfigs.push(oFresh);
				} else if (!aConfigs[i].dirty) {
					aConfigs[i] = oFresh;
				}
			});
			_oModel.setProperty("/configs", _sortConfigs(aConfigs));
			return _configsOf(sType);
		});
	}

	// API §2.1 (condition types) + §3.2 (full matrix, exactly as documented: no business keys), then
	// §3.1 per active condition type for the business keys the pricing form needs.
	function _loadCatalog() {
		return Promise.all([
			capService.list(TYPE_SET, { $filter: "IS_ACTIVE eq true" }),
			capService.list(TYPE_COMB_SET, { $expand: "CONDITION_TYPE,KEY_COMBINATION" })
		]).then(function (aResults) {
			_applyCatalog(aResults[0], aResults[1]);
			_mAvailable.config = true;
			_mAvailable.records = true;
			_oModel.setProperty("/serviceError", "");
			// §3.1 per type: a failure leaves the condition types and the matrix usable; only the
			// business keys (key fields, DIST_CHANNEL / HIERARCHY defaults) of that type are missing.
			var aFailed = [];
			return Promise.all(_aTypeOrder.map(function (sType) {
				return _loadConfigsFor(sType).catch(function (oError) {
					aFailed.push(sType + ": " + oError.message);
				});
			})).then(function () {
				_oModel.setProperty("/keysError", aFailed.length ? "The business keys of " + TYPE_COMB_SET +
					" could not be read (" + aFailed.join("; ") + ")." : "");
			});
		}).catch(function (oError) {
			_clearCatalog();
			_mAvailable.config = false;
			_mAvailable.records = false;
			_oModel.setProperty("/serviceError", oError.message);
		});
	}

	function _configs() {
		return _oModel.getProperty("/configs") || [];
	}

	function typeInfo(sType) {
		return _mTypes[sType] || null;
	}

	function combinationInfo(sComb) {
		return _mCombs[sComb] || null;
	}

	function fieldsOf(sComb) {
		return (_mCombs[sComb] || {}).fields || [];
	}

	// BUSINESS_KEYS.DEFAULT_VALUE of a key field of a combination ("" when not maintained).
	function keyDefault(sComb, sFieldCode) {
		var oKey = ((_mCombs[sComb] || {}).keys || []).find(function (k) { return k.code === sFieldCode; });
		return (oKey && oKey.defaultValue) || "";
	}

	// Distribution channel of a combination: always the DIST_CHANNEL business key's DEFAULT_VALUE
	// (API §3.1, "10"); it is not entered by the user.
	function distChannelFor(sComb) {
		return keyDefault(sComb, "DIST_CHANNEL");
	}

	// Hierarchy of a brand combination: always the HIERARCHY business key's DEFAULT_VALUE (API §3.1,
	// "L2"); "" for combinations without a brand. It is not entered by the user.
	function hierarchyFor(sComb) {
		return fieldsOf(sComb).indexOf("brand") !== -1 ? keyDefault(sComb, "HIERARCHY") : "";
	}

	function getConfig(sType, sComb) {
		return _configs().find(function (c) {
			return c.conditionType === sType && c.combination === sComb;
		}) || null;
	}

	// Active combinations for a condition type (CFG-006: inactive ones are not offered for new
	// records); the default one is the proposal.
	function combinationsFor(sType) {
		return _configs().filter(function (c) {
			return c.conditionType === sType && c.active && (_mCombs[c.combination] || {}).active !== false;
		}).map(function (c) { return c.combination; });
	}

	function defaultCombination(sType) {
		var aCombs = combinationsFor(sType);
		var sDefault = aCombs.find(function (sComb) { return getConfig(sType, sComb).isDefault; });
		return sDefault || aCombs[0] || "";
	}

	function tableName(sTableNo) {
		return sTableNo ? "A" + sTableNo : "";
	}

	// Local checks before the configuration is saved.
	function validateConfigs(aConfigs) {
		var aMsg = [];
		var mDefaults = {};
		(aConfigs || _configs()).forEach(function (c) {
			var sKey = c.conditionType + " " + c.combination;
			if (c.tableNo && !/^\d{3}$/.test(c.tableNo)) {
				aMsg.push(_err(sKey + ": condition table number must be exactly 3 digits (e.g. 901).", sKey));
			}
			if (c.active && !c.tableNo) {
				aMsg.push({ type: "Warning", text: sKey + ": active but no condition table number; posting stays blocked.", field: sKey });
			}
			if (c.isDefault) {
				mDefaults[c.conditionType] = (mDefaults[c.conditionType] || 0) + 1;
			}
		});
		Object.keys(mDefaults).forEach(function (sType) {
			if (mDefaults[sType] > 1) {
				aMsg.push(_err(sType + ": at most one default combination is allowed.", sType));
			}
		});
		return aMsg;
	}

	// ---------------------------------------------------------------- condition rows

	function _rows() {
		return _oModel.getProperty("/conditions") || [];
	}

	function _setRows(aRows) {
		_oModel.setProperty("/conditions", aRows);
	}

	function _nextRowId() {
		_iRowSeq += 1;
		return String(_iRowSeq);
	}

	function _recordPath(sId) {
		return RECORD_SET + "(" + capService.literal(sId) + ")";
	}

	function _setStatus(oRow, sStatus, sMessage) {
		oRow.status = sStatus;
		oRow.statusState = STATUS_STATE[sStatus] || "None";
		oRow.message = sMessage || "";
	}

	function _statusFromBackend(s) {
		var sUpper = String(s || "").toUpperCase();
		return sUpper === RECORD_STATUS.POSTED ? STATUS.POSTED : sUpper === RECORD_STATUS.FAILED ? STATUS.FAILED : STATUS.DRAFT;
	}

	function _rowFromBackend(r) {
		var oType = _mTypes[r[FIELD.conditionType]] || {};
		var bPercent = oType.kind === "percent";
		var bPrice = oType.kind === "price";
		var oRow = {
			rowId: r[FIELD.rowId],
			persisted: true,
			campaignId: r[FIELD.campaignId],
			conditionType: r[FIELD.conditionType],
			combination: r[FIELD.combination],
			salesOrg: r[FIELD.salesOrg] || "",
			distChannel: r[FIELD.distChannel] || "",
			customer: r[FIELD.customer] || "",
			article: r[FIELD.article] || "",
			hierarchy: r[FIELD.hierarchy] || "",
			brand: r[FIELD.brand] || "",
			rate: _numText(r[FIELD.rate]),
			rateUnit: bPercent ? PERCENT : (r[FIELD.rateUnit] || ""),
			pricingUnit: bPrice ? _numText(r[FIELD.pricingUnit]) : "",
			uom: bPrice ? (r[FIELD.uom] || "") : "",
			validFrom: _parseDate(r[FIELD.validFrom]),
			validTo: _parseDate(r[FIELD.validTo]),
			tableNo: r[FIELD.tableNo] || "",
			recordNo: r[FIELD.recordNo] || "",
			createdBy: r[FIELD.createdBy] || "",
			createdOn: _parseDate(r[FIELD.createdOn]),
			changedBy: r[FIELD.changedBy] || "",
			changedOn: _parseDate(r[FIELD.changedOn])
		};
		_setStatus(oRow, _statusFromBackend(r[FIELD.status]), r[FIELD.message] || "");
		// API §5.5: only records stored with STATUS DRAFT can be deleted.
		oRow.deletable = String(r[FIELD.status] || RECORD_STATUS.DRAFT).toUpperCase() === RECORD_STATUS.DRAFT;
		return oRow;
	}

	// API §5.2 body; only the key fields of the selected combination are filled. CREATED_BY / _AT and
	// MODIFIED_BY / _AT are not sent: the deployed CampaignPricingRecords entity has no such
	// properties ("Property CREATED_BY does not exist"); audit data, if any, is set by the service.
	function _recordPayload(oRow) {
		var aFields = fieldsOf(oRow.combination);
		var sKind = (_mTypes[oRow.conditionType] || {}).kind;
		var o = {};
		o[FIELD.rowId] = oRow.rowId;
		o[FIELD.campaignId] = oRow.campaignId;
		o[FIELD.conditionType] = oRow.conditionType;
		o[FIELD.combination] = oRow.combination;
		o[FIELD.salesOrg] = oRow.salesOrg;
		o[FIELD.distChannel] = oRow.distChannel;
		o[FIELD.customer] = aFields.indexOf("customer") !== -1 ? oRow.customer : null;
		o[FIELD.article] = aFields.indexOf("article") !== -1 ? oRow.article : null;
		o[FIELD.brand] = aFields.indexOf("brand") !== -1 ? oRow.brand : null;
		o[FIELD.hierarchy] = aFields.indexOf("brand") !== -1 ? oRow.hierarchy : null;
		o[FIELD.validFrom] = _toIsoDate(oRow.validFrom);
		o[FIELD.validTo] = _toIsoDate(oRow.validTo);
		o[FIELD.rate] = _num(oRow.rate);
		o[FIELD.rateUnit] = sKind === "percent" ? null : oRow.rateUnit;
		o[FIELD.pricingUnit] = sKind === "price" ? _num(oRow.pricingUnit) : null;
		o[FIELD.uom] = sKind === "price" ? oRow.uom : null;
		o[FIELD.status] = RECORD_STATUS.DRAFT;
		o[FIELD.recordNo] = null;
		o[FIELD.tableNo] = oRow.tableNo || null;
		o[FIELD.message] = null;
		return o;
	}

	// Edm.DateTime of the S/4 API: UTC midnight of the calendar date, "/Date(ms)/".
	function _toS4Date(d) {
		return d ? "/Date(" + Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) + ")/" : null;
	}

	function _s4Property(oKey) {
		var sS4 = String(oKey.s4Field || "").trim();
		if (sS4 && _aValidityProps.indexOf(sS4) !== -1) {
			return sS4;
		}
		return S4_KEY_PROPERTY[sS4.toUpperCase()] || S4_KEY_PROPERTY[oKey.code] || "";
	}

	// to_SlsPrcgCndnRecdValidity key properties of the record's combination. Keys without an S/4
	// property (e.g. HIERARCHY when the brand node carries it) are skipped if not required; a
	// required key without one blocks the post.
	function _s4Keys(oRow) {
		var oComb = _mCombs[oRow.combination] || { keys: [] };
		var oKeys = {};
		var aMissing = [];
		oComb.keys.forEach(function (k) {
			var sProp = _s4Property(k);
			var sValue = oRow[KEY_VALUE[k.code]] || k.defaultValue || "";
			if (!sProp) {
				if (k.required && k.code !== "HIERARCHY") {
					aMissing.push(k.field);
				}
				return;
			}
			if (sValue) {
				oKeys[sProp] = sValue;
			}
		});
		if (aMissing.length) {
			throw _throw(_err("No S/4 field is mapped for " + aMissing.join(", ") + " of " + oRow.combination +
				". Maintain S4_FIELD of the business key with the A_SlsPrcgCndnRecdValidity property name."));
		}
		return oKeys;
	}

	// A_SlsPrcgConditionRecord deep insert: header (table, application, type, rate) + one validity
	// entry with dates and the combination's key fields.
	// "100" -> "100.00"; more decimals than two are kept as entered.
	function _s4Rate(vRate) {
		var sRate = String(vRate).trim();
		var iDecimals = (sRate.split(".")[1] || "").length;
		return Number(sRate).toFixed(Math.max(2, iDecimals));
	}

	function _s4Payload(oRow) {
		var sKind = (_mTypes[oRow.conditionType] || {}).kind;
		var bPercent = sKind === "percent";
		var bPrice = sKind === "price";
		var oAll = Object.assign({
			ConditionValidityStartDate: _toS4Date(oRow.validFrom),
			ConditionValidityEndDate: _toS4Date(oRow.validTo)
		}, _s4Keys(oRow));
		var oValidity = {};
		S4_VALIDITY_ORDER.concat(Object.keys(oAll)).forEach(function (sProp) {
			if (sProp in oAll && !(sProp in oValidity)) {
				oValidity[sProp] = oAll[sProp];
			}
		});
		return {
			ConditionTable: oRow.tableNo || S4_DEFAULT_TABLE,
			ConditionApplication: S4_APPLICATION,
			ConditionType: oRow.conditionType,
			ConditionRateValue: _s4Rate(oRow.rate),
			ConditionRateValueUnit: bPercent ? PERCENT : oRow.rateUnit,
			ConditionCurrency: (!bPercent && oRow.rateUnit) || S4_DEFAULT_CURRENCY,
			ConditionQuantity: (bPrice && String(oRow.pricingUnit || "").trim()) || S4_DEFAULT_QUANTITY,
			ConditionQuantityUnit: (bPrice && oRow.uom) || S4_DEFAULT_QUANTITY_UNIT,
			to_SlsPrcgCndnRecdValidity: [oValidity]
		};
	}

	// §12 row validation (field checks only; overlapping validity is checked by the backend).
	function validateRow(oRow, aOthers) {
		var aMsg = [];
		var oType = _mTypes[oRow.conditionType];
		var aFields = fieldsOf(oRow.combination);
		if (!oRow.campaignId) {
			aMsg.push(_err("Campaign ID is mandatory.", "campaignId"));
		}
		if (!oType) {
			aMsg.push(_err("Select a condition type.", "conditionType"));
			return aMsg;
		}
		var oCfg = getConfig(oRow.conditionType, oRow.combination);
		if (!oCfg) {
			aMsg.push(_err("Select a key combination allowed for " + oRow.conditionType + ".", "combination"));
			return aMsg;
		}
		if (!oCfg.active || (_mCombs[oRow.combination] || {}).active === false) {
			aMsg.push(_err(oRow.conditionType + " " + oRow.combination + " is not an active key combination.", "combination"));
		}
		if (!/^[A-Z0-9]{4}$/.test(oRow.salesOrg || "")) {
			aMsg.push(_err("Sales organization is mandatory (4 characters).", "salesOrg"));
		}
		var sDistChannel = distChannelFor(oRow.combination);
		if (!sDistChannel) {
			aMsg.push(_err("No distribution channel is maintained for " + oRow.combination +
				" (DEFAULT_VALUE of business key DIST_CHANNEL).", "distChannel"));
		} else if (oRow.distChannel !== sDistChannel) {
			aMsg.push(_err("Distribution channel must be " + sDistChannel + ".", "distChannel"));
		}
		if (aFields.indexOf("customer") !== -1 && !oRow.customer) {
			aMsg.push(_err("Customer is mandatory for " + oRow.combination + ".", "customer"));
		}
		if (aFields.indexOf("article") !== -1 && !oRow.article) {
			aMsg.push(_err("Article / SKU is mandatory for " + oRow.combination + ".", "article"));
		}
		if (aFields.indexOf("brand") !== -1) {
			if (!oRow.brand) {
				aMsg.push(_err("Brand is mandatory for " + oRow.combination + ".", "brand"));
			}
			var sHierarchy = hierarchyFor(oRow.combination);
			if (!sHierarchy) {
				aMsg.push(_err("No hierarchy is maintained for " + oRow.combination +
					" (DEFAULT_VALUE of business key HIERARCHY).", "hierarchy"));
			} else if (oRow.hierarchy !== sHierarchy) {
				aMsg.push(_err("Hierarchy must be " + sHierarchy + ".", "hierarchy"));
			}
		}
		if (!oRow.validFrom) {
			aMsg.push(_err("Valid From is mandatory.", "validFrom"));
		}
		if (!oRow.validTo) {
			aMsg.push(_err("Valid To is mandatory.", "validTo"));
		}
		if (oRow.validFrom && oRow.validTo && oRow.validFrom > oRow.validTo) {
			aMsg.push(_err("Valid From cannot be after Valid To.", "validTo"));
		}
		var sRate = String(oRow.rate === undefined || oRow.rate === null ? "" : oRow.rate).trim();
		if (!/^\d+(\.\d+)?$/.test(sRate) || Number(sRate) <= 0) {
			aMsg.push(_err(oType.kind === "percent" ? "Enter a discount percentage greater than 0." :
				"Enter a condition amount greater than 0.", "rate"));
		} else if (oType.kind === "percent" && Number(sRate) > 100) {
			aMsg.push(_err("Discount percentage cannot exceed 100.", "rate"));
		} else if (oType.kind === "percent" && !/^\d+(\.\d{1,2})?$/.test(sRate)) {
			aMsg.push(_err("Discount percentage allows at most 2 decimals.", "rate"));
		}
		if (oType.kind !== "percent" && !/^[A-Z]{3}$/.test(oRow.rateUnit || "")) {
			aMsg.push(_err("Currency is mandatory.", "rateUnit"));
		}
		if (oType.kind === "price") {
			if (!/^[1-9]\d{0,4}$/.test(String(oRow.pricingUnit || "").trim())) {
				aMsg.push(_err("Pricing unit must be a whole number greater than 0.", "pricingUnit"));
			}
			if (!oRow.uom) {
				aMsg.push(_err("Unit of measure is mandatory.", "uom"));
			}
		}
		return aMsg;
	}

	// Trims and upper-cases the free-text keys like SAP conversion would.
	function _normalize(oRow) {
		var o = Object.assign({}, oRow);
		["salesOrg", "distChannel", "customer", "article", "brand", "hierarchy", "rateUnit", "uom"].forEach(function (k) {
			o[k] = String(o[k] || "").trim().toUpperCase();
		});
		o.rate = String(o.rate === undefined || o.rate === null ? "" : o.rate).trim();
		o.pricingUnit = String(o.pricingUnit || "").trim();
		o.validFrom = _day(o.validFrom);
		o.validTo = _day(o.validTo);
		var aFields = fieldsOf(o.combination);
		o.distChannel = distChannelFor(o.combination);
		o.hierarchy = hierarchyFor(o.combination);
		["customer", "article", "brand"].forEach(function (k) {
			if (aFields.indexOf(k) === -1) {
				o[k] = "";
			}
		});
		var oType = _mTypes[o.conditionType];
		if (oType && oType.kind === "percent") {
			o.rateUnit = PERCENT;
		}
		if (!oType || oType.kind !== "price") {
			o.pricingUnit = "";
			o.uom = "";
		}
		return o;
	}

	function conditionsOf(sCampaignId) {
		return _rows().filter(function (o) { return o.campaignId === sCampaignId; });
	}

	// Draft, failed and locally invalid rows are re-validated; posted ones are final.
	function _validateOpen(sCampaignId) {
		var aAll = conditionsOf(sCampaignId);
		var aOpen = aAll.filter(function (o) { return o.status !== STATUS.POSTED; });
		aOpen.forEach(function (oRow) {
			var aMsg = validateRow(oRow, aAll);
			if (aMsg.length) {
				_setStatus(oRow, STATUS.ERROR, aMsg.map(function (m) { return m.text; }).join(" "));
			} else if (oRow.status === STATUS.ERROR) {
				_setStatus(oRow, STATUS.DRAFT);
			}
		});
		return aOpen;
	}

	// "ZSRP KC01 MY01 / 0010000001 / ...: <message>" for every row of the campaign in status Error.
	function _errorTexts(sCampaignId) {
		return conditionsOf(sCampaignId).filter(function (o) {
			return o.status === STATUS.ERROR;
		}).map(function (o) {
			var sKeys = [o.salesOrg, o.customer, o.article, o.brand].filter(Boolean).join(" / ");
			return o.conditionType + " " + o.combination + (sKeys ? " " + sKeys : "") + ": " + o.message;
		});
	}

	// S/4 post of one record; resolves with the KNUMH.
	function _postToS4(oRow) {
		var oPayload;
		try {
			oPayload = _s4Payload(oRow);
		} catch (e) {
			return Promise.reject(e);
		}
		return _post(S4_CONDITION_SET, oPayload).then(function (oData) {
			// KNUMH: on the header, else on the returned validity entry of the deep insert.
			var oValidity = oData.to_SlsPrcgCndnRecdValidity || {};
			var aValidity = oValidity.results || (Array.isArray(oValidity) ? oValidity : []);
			var sRecordNo = oData.ConditionRecord || (aValidity[0] || {}).ConditionRecord || "";
			if (!sRecordNo) {
				throw _throw(_err("S/4 did not return a condition record number."));
			}
			return sRecordNo;
		});
	}

	// Stores the S/4 result on the CAP record (API §5.3 / §5.4) and on the row. A posted record whose
	// status cannot be stored stays Posted here (S/4 has it) but shows why.
	function _storeResult(oRow, bPosted, sRecordNo, sMessage) {
		// §5.3 { STATUS: POSTED, RECORD_NUMBER, ERROR_MESSAGE: null } / §5.4 { STATUS: FAILED, ERROR_MESSAGE }
		var oPatch = {};
		oPatch[FIELD.status] = bPosted ? RECORD_STATUS.POSTED : RECORD_STATUS.FAILED;
		if (bPosted) {
			oPatch[FIELD.recordNo] = sRecordNo;
		}
		oPatch[FIELD.message] = bPosted ? null : sMessage;
		var pPatch = oRow.persisted ? capService.update(_recordPath(oRow.rowId), oPatch) : Promise.resolve(null);
		return pPatch.then(function (oData) {
			oRow.deletable = false;
			oRow.recordNo = bPosted ? sRecordNo : "";
			_setStatus(oRow, bPosted ? STATUS.POSTED : STATUS.FAILED, bPosted ? "" : sMessage);
			if (oData) {
				oRow.changedBy = oData[FIELD.changedBy] || oRow.changedBy;
				oRow.changedOn = _parseDate(oData[FIELD.changedOn]) || oRow.changedOn;
			}
		}, function (oError) {
			// the stored record is still DRAFT
			oRow.deletable = !bPosted;
			oRow.recordNo = bPosted ? sRecordNo : "";
			_setStatus(oRow, bPosted ? STATUS.POSTED : STATUS.FAILED, bPosted ?
				"Posted to S/4 as " + sRecordNo + ", but the status could not be stored: " + oError.message :
				sMessage + " (status not stored: " + oError.message + ")");
		});
	}

	function _refresh() {
		_oModel.refresh(true);
	}

	function _newModel() {
		return new JSONModel({ conditions: [], configs: [], brands: [], salesOrgs: [], customers: [], articles: [], currencies: [], uoms: [], available: {}, serviceError: "", keysError: "" });
	}

	function _publishAvailability() {
		_oModel.setProperty("/available", Object.assign({}, _mAvailable));
	}

	// ---------------------------------------------------------------- public API

	return {
		STATUS: STATUS,
		STATUS_STATE: STATUS_STATE,
		VALIDATION: VALIDATION,
		PERCENT: PERCENT,

		// Loads condition types and the configuration matrix from CAP once and checks whether S/4
		// posting is available. Resolves also when CAP cannot be read (empty catalogue, /serviceError set).
		init: function (oComponent) {
			_oComponent = oComponent;
			capService.init(oComponent);
			if (!_oModel) {
				_oModel = _newModel();
			}
			if (!_pInit) {
				_bFreshCatalog = true;
				_pInit = Promise.all([_detectPosting(), _loadCatalog()]).then(_publishAvailability).catch(function (oError) {
					_pInit = null;
					throw oError;
				});
			}
			return _pInit;
		},

		getModel: function () {
			return _oModel;
		},

		// Reads condition types (API 2.1), the matrix (3.2) and the business keys per type (3.1) again,
		// so table numbers / flags maintained in CAP since the last read are used. Mappings edited here
		// and not saved yet are kept. When CAP cannot be read, the previous catalogue stays.
		reloadCatalog: function () {
			var that = this;
			return this.init(_oComponent).then(function () {
				if (_bFreshCatalog) {
					// init has just read it
					_bFreshCatalog = false;
					return that;
				}
				var oBefore = {
					types: _mTypes, combs: _mCombs, order: _aTypeOrder, configs: _configs(),
					available: Object.assign({}, _mAvailable), keysError: _oModel.getProperty("/keysError")
				};
				var aDirty = oBefore.configs.filter(function (c) { return c.dirty; });
				return _loadCatalog().then(function () {
					if (!_mAvailable.config && oBefore.available.config) {
						var sError = _oModel.getProperty("/serviceError");
						_mTypes = oBefore.types;
						_mCombs = oBefore.combs;
						_aTypeOrder = oBefore.order;
						_mAvailable.config = oBefore.available.config;
						_mAvailable.records = oBefore.available.records;
						_oModel.setProperty("/configs", oBefore.configs);
						_oModel.setProperty("/keysError", oBefore.keysError);
						_oModel.setProperty("/serviceError", "");
						throw new Error(sError || "The pricing configuration could not be read again.");
					}
					var aConfigs = _configs();
					aDirty.forEach(function (d) {
						var i = aConfigs.findIndex(function (c) {
							return c.conditionType === d.conditionType && c.combination === d.combination;
						});
						if (i !== -1) {
							aConfigs[i] = d;
						}
					});
					_oModel.setProperty("/configs", aConfigs);
					_publishAvailability();
					return that;
				});
			});
		},

		// "config" / "records": CAP service readable; "posting": S/4 A_SlsPrcgConditionRecord reachable.
		isAvailable: function (sService) {
			return !!_mAvailable[sService];
		},

		typeInfo: typeInfo,
		combinationInfo: combinationInfo,
		fieldsOf: fieldsOf,
		distChannelFor: distChannelFor,
		hierarchyFor: hierarchyFor,
		combinationsFor: combinationsFor,
		defaultCombination: defaultCombination,
		getConfig: getConfig,
		tableName: tableName,
		validateRow: validateRow,
		validateConfigs: validateConfigs,
		conditionsOf: conditionsOf,

		// Condition type codes in display order.
		conditionTypes: function () {
			return _aTypeOrder.slice();
		},

		currencyFor: function (sCountry) {
			return COUNTRY_CURRENCY[sCountry] || "";
		},

		// A new draft with the §2 / §17 defaults: Campaign ID, DC and hierarchy from the combination's
		// business keys, currency from country.
		newDraft: function (sCampaignId, sCountry, sType, sComb) {
			var sConditionType = _mTypes[sType] ? sType : (_mTypes.ZPWP ? "ZPWP" : _aTypeOrder[0]);
			var bPercent = (_mTypes[sConditionType] || {}).kind === "percent";
			var sCombination = sComb || defaultCombination(sConditionType);
			return {
				campaignId: sCampaignId,
				conditionType: sConditionType,
				combination: sCombination,
				salesOrg: "",
				distChannel: distChannelFor(sCombination),
				customer: "",
				article: "",
				hierarchy: hierarchyFor(sCombination),
				brand: "",
				rate: "",
				rateUnit: bPercent ? PERCENT : (COUNTRY_CURRENCY[sCountry] || ""),
				pricingUnit: "1",
				uom: "EA",
				validFrom: null,
				validTo: null
			};
		},

		// API §5.1: the campaign's records replace its rows; session-only rows stay when CAP is down.
		loadConditions: function (sCampaignId) {
			if (!_mAvailable.records) {
				return Promise.resolve(conditionsOf(sCampaignId));
			}
			return capService.list(RECORD_SET, {
				$filter: FIELD.campaignId + " eq " + capService.literal(sCampaignId),
				$expand: "CONDITION_TYPE,KEY_COMBINATION"
			}).then(function (aData) {
				var aLoaded = aData.filter(function (r) { return r[FIELD.campaignId] === sCampaignId; }).map(_rowFromBackend);
				var aKeep = _rows().filter(function (o) { return o.campaignId !== sCampaignId || !o.persisted; });
				_setRows(aKeep.concat(aLoaded));
				return conditionsOf(sCampaignId);
			});
		},

		// Validates the draft and stores it as a DRAFT record (API §5.2); rejects with field messages.
		// The configured condition table number is kept as snapshot.
		addDraft: function (oDraft) {
			var oRow = _normalize(oDraft);
			var aMsg = validateRow(oRow, conditionsOf(oRow.campaignId));
			if (aMsg.length) {
				return Promise.reject(_throw(aMsg));
			}
			var oCfg = getConfig(oRow.conditionType, oRow.combination);
			oRow.tableNo = (oCfg && oCfg.tableNo) || "";
			oRow.recordNo = "";
			if (!_mAvailable.records) {
				oRow.rowId = _nextRowId();
				oRow.persisted = false;
				oRow.deletable = true;
				_setStatus(oRow, STATUS.DRAFT);
				_setRows(_rows().concat([oRow]));
				return Promise.resolve(oRow);
			}
			oRow.rowId = capService.uuid();
			var oPayload = _recordPayload(oRow);
			return capService.create(RECORD_SET, oPayload).then(function (oData) {
				var oSaved = _rowFromBackend(Object.assign({}, oPayload, oData || {}));
				_setRows(_rows().concat([oSaved]));
				return oSaved;
			});
		},

		// Several drafts at once (multi-select key fields: one row per combination of the picked
		// values). All rows are validated first, against the campaign's records and each other; when
		// any row is invalid nothing is stored. Otherwise they are stored one by one like addDraft.
		addDrafts: function (aDrafts) {
			var that = this;
			var aRows = aDrafts.map(function (oDraft, i) {
				return Object.assign(_normalize(oDraft), { rowId: "new-" + i });
			});
			var mSeen = {};
			var aMsg = [];
			aRows.forEach(function (oRow, i) {
				var aOthers = conditionsOf(oRow.campaignId).concat(aRows.slice(0, i));
				validateRow(oRow, aOthers).forEach(function (m) {
					var sKeys = ["salesOrg", "customer", "article", "brand", "rateUnit", "uom"].map(function (k) { return oRow[k]; })
						.filter(Boolean).join(" / ");
					var oMsg = aRows.length > 1 && sKeys ? Object.assign({}, m, { text: sKeys + ": " + m.text }) : m;
					if (!mSeen[oMsg.text]) {
						mSeen[oMsg.text] = true;
						aMsg.push(oMsg);
					}
				});
			});
			if (aMsg.length) {
				return Promise.reject(_throw(aMsg));
			}
			return aRows.reduce(function (p, oRow) {
				return p.then(function (aDone) {
					return that.addDraft(Object.assign({}, oRow, { rowId: undefined })).then(function (oSaved) {
						return aDone.concat([oSaved]);
					});
				});
			}, Promise.resolve([]));
		},

		// API §5.5: only DRAFT records can be deleted (CAP only); posted and failed records stay.
		removeDraft: function (sRowId) {
			var oRow = _rows().find(function (o) { return o.rowId === sRowId; });
			if (!oRow) {
				return Promise.resolve();
			}
			if (!oRow.deletable) {
				return Promise.reject(_throw(_err("Only draft records can be deleted.")));
			}
			var pDelete = oRow.persisted ? capService.remove(_recordPath(sRowId)) : Promise.resolve();
			return pDelete.then(function () {
				_setRows(_rows().filter(function (o) { return o.rowId !== sRowId; }));
			});
		},

		// Re-validates every open row of the campaign; returns counts.
		validateDrafts: function (sCampaignId) {
			var aOpen = _validateOpen(sCampaignId);
			_refresh();
			return {
				open: aOpen.length,
				errors: aOpen.filter(function (o) { return o.status === STATUS.ERROR; }).length
			};
		},

		// §4.2 / §13 save: validates open rows, posts each valid row to S/4 on its own so one failure
		// does not roll back the others, then stores the result on the record: POSTED + RECORD_NUMBER
		// or FAILED + ERROR_MESSAGE. Posted rows are never posted again; failed rows can be retried.
		save: function (sCampaignId) {
			var aValid = _validateOpen(sCampaignId).filter(function (o) { return o.status !== STATUS.ERROR; });
			if (!aValid.length) {
				_refresh();
				var aErrors = _errorTexts(sCampaignId);
				return Promise.resolve({ saved: 0, failed: 0, errors: aErrors.length, messages: aErrors });
			}
			if (!_mAvailable.posting) {
				_refresh();
				return Promise.reject(_throw(_err("The S/4 pricing API (" + S4_MODEL + S4_CONDITION_SET +
					") cannot be reached. Nothing was posted to S/4; " + (_mAvailable.records ?
					"the records stay stored with status Draft." : "the draft rows are kept in this session."))));
			}
			var aPost = [];
			aValid.forEach(function (oRow) {
				// No UI block on the condition table: the configured number, else the record's own
				// CONDITION_TABLE_NUMBER; S/4 decides and its answer is stored (POSTED / FAILED).
				var oCfg = getConfig(oRow.conditionType, oRow.combination);
				oRow.tableNo = (oCfg && oCfg.tableNo) || oRow.tableNo || "";
				aPost.push(oRow);
			});
			return Promise.allSettled(aPost.map(function (oRow) {
				return _postToS4(oRow).then(function (sRecordNo) {
					return _storeResult(oRow, true, sRecordNo, "");
				}, function (oError) {
					return _storeResult(oRow, false, "", oError.message).then(function () {
						throw oError;
					});
				});
			})).then(function (aResults) {
				_refresh();
				var aErrors = _errorTexts(sCampaignId);
				var aFailed = aResults.filter(function (r) { return r.status === "rejected"; }).map(function (r) {
					return (r.reason && r.reason.message) || String(r.reason);
				});
				// "ZSRP KC01 MY01 / 0010000001 / ...: 0000123456" for every row posted now.
				var aPosted = aPost.filter(function (oRow, i) {
					return aResults[i].status === "fulfilled";
				}).map(function (o) {
					var sKeys = [o.salesOrg, o.customer, o.article, o.brand].filter(Boolean).join(" / ");
					return o.conditionType + " " + o.combination + (sKeys ? " " + sKeys : "") + ": " + o.recordNo;
				});
				return {
					posted: aPosted,
					saved: aResults.filter(function (r) { return r.status === "fulfilled"; }).length,
					failed: aFailed.length,
					errors: aErrors.length,
					messages: aErrors.concat(aFailed)
				};
			});
		},

		// Value help lists from the CAP backend (SalesOrganizations, BrandsMaster, Customers, Articles,
		// Currencies, UnitsOfMeasure), read once per session, up to VALUE_HELP_LIMIT entries each, into
		// /salesOrgs, /brands, /customers, /articles, /currencies, /uoms.
		// A failed read leaves only that list empty.
		loadValueHelps: function () {
			if (!_pValueHelps) {
				_pValueHelps = Promise.all(Object.keys(VALUE_HELPS).map(function (sList) {
					var oDef = VALUE_HELPS[sList];
					return capService.list(oDef.set, { $top: VALUE_HELP_LIMIT }).then(function (aRows) {
						_oModel.setProperty("/" + sList, oDef.items(aRows).slice(0, VALUE_HELP_LIMIT));
					}).catch(function () {
						_oModel.setProperty("/" + sList, []);
					});
				}));
			}
			return _pValueHelps;
		},

		// Condition types for the dropdown: [{ key, text }], from CAP ConditionTypes only. Rejects with
		// the service error when CAP cannot be read.
		loadConditionTypes: function () {
			if (!_mAvailable.config) {
				return Promise.reject(new Error(_oModel.getProperty("/serviceError") ||
					"The campaign pricing service (" + TYPE_SET + ") cannot be reached."));
			}
			return Promise.resolve(_aTypeOrder.map(function (k) {
				return { key: k, text: _mTypes[k].description };
			}));
		},

		// Backend description of a condition type ("" when not known).
		conditionTypeText: function (sType) {
			return (_mTypes[sType] || {}).description || "";
		},

		// Backend description of a key combination ("" when not known).
		combinationText: function (sComb) {
			return (_mCombs[sComb] || {}).description || "";
		},

		// API §3.1 for one condition type (Axxx Config table when a type is selected). Resolves with
		// the type's mappings.
		loadConfigsFor: function (sType) {
			if (!_mAvailable.config || !sType) {
				return Promise.resolve(_configsOf(sType));
			}
			return _loadConfigsFor(sType);
		},

		// API §3.3: PATCH each changed mapping (table number, default, active). Entries losing their
		// default flag go first, so the service never sees two defaults for one condition type.
		saveConfigs: function () {
			var aMsg = validateConfigs().filter(function (m) { return m.type === "Error"; });
			if (aMsg.length) {
				return Promise.reject(_throw(aMsg));
			}
			var aDirty = _configs().filter(function (c) { return c.dirty; }).sort(function (a, b) {
				return Number(a.isDefault) - Number(b.isDefault);
			});
			if (!aDirty.length) {
				return Promise.resolve({ saved: 0, failed: 0 });
			}
			if (!_mAvailable.config) {
				return Promise.reject(_throw(_err("The campaign pricing configuration service (" + TYPE_COMB_SET +
					") cannot be reached. The changes were not saved and only apply in this session.")));
			}
			var aFailed = [];
			var iSaved = 0;
			return aDirty.reduce(function (pPrev, c) {
				return pPrev.then(function () {
					var sPath = TYPE_COMB_SET + "(CONDITION_TYPE_ID=" + c.conditionTypeId + ",KEY_COMBINATION_ID=" + c.combinationId + ")";
					return capService.update(sPath, {
						CONDITION_TABLE_NUMBER: c.tableNo || null,
						DEFAULT_FLAG: !!c.isDefault,
						IS_ACTIVE: !!c.active
					}).then(function (oData) {
						if (oData) {
							c.tableNo = oData.CONDITION_TABLE_NUMBER === "TBD" ? "" : (oData.CONDITION_TABLE_NUMBER || "");
							c.isDefault = !!oData.DEFAULT_FLAG;
							c.active = !!oData.IS_ACTIVE;
						}
						c.dirty = false;
						c.validation = VALIDATION.SAVED;
						iSaved += 1;
					}, function (oError) {
						c.validation = VALIDATION.FAILED;
						aFailed.push(oError.message);
					});
				});
			}, Promise.resolve()).then(function () {
				_refresh();
				return { saved: iSaved, failed: aFailed.length, messages: aFailed };
			});
		},

		// Marks a configuration entry as edited locally.
		markConfigChanged: function (oConfig) {
			oConfig.dirty = true;
			oConfig.validation = _mAvailable.config ? VALIDATION.CHANGED : VALIDATION.LOCAL;
		},

		// Test hook: drop all session state.
		_reset: function () {
			_oModel = null;
			_pInit = null;
			_bFreshCatalog = false;
			_pValueHelps = null;
			_iRowSeq = 0;
			_mAvailable = { config: false, records: false, posting: false };
			_aValidityProps = [];
			_mTypes = {};
			_mCombs = {};
			_aTypeOrder = [];
		},

		// Test hook: a model without a backend, loaded with the given ConditionTypes and
		// ConditionTypeKeyCombinations rows (same shape as the CAP response).
		_initLocal: function (aTypes, aRows) {
			_oModel = _newModel();
			_applyCatalog(aTypes || [], aRows || []);
		}
	};
});
