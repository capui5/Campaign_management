sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator"
], function (JSONModel, Filter, FilterOperator) {
	"use strict";

	// Campaign pricing conditions + Axxx key configuration facade (Campaign Management FDD/TDD v1.1,
	// §3, §4.2, §5 "Pricing tab", §12, §13, §19 - §21).
	//
	// The UI talks only to this module; every public method that calls the backend returns a Promise.
	//
	// Backend: mainModel (ZSDGW_CE_APP_SRV). The FDD's pricing services are proposed, not built yet:
	//   CONDITION_SET  ZSD_CAMP_COND link + SaveBatch orchestration (§8 ZUI_CAMPAIGN_PRICING)
	//     read    CampaignConditionSet?$filter=CampaignId eq 'C-...'   records linked to a campaign
	//     create  POST CampaignConditionSet                             one row per condition record (§9
	//                                                                   payload); returns ConditionRecordNo
	//     delimit MERGE CampaignConditionSet('<KNUMH>')                  new ValidTo only
	//   CONFIG_SET     ZSD_CAMP_CONFC (§18.1, §21 CampaignPricingConfiguration)
	//     read    CampaignPricingConfigSet                              20 type/combination mappings
	//     save    POST CampaignPricingConfigSet                         backend validates and returns
	//                                                                   ValidationStatus (§21.1)
	//   BrandSet       brand value help (WRF_BRANDS), filtered by store like the sales order app.
	//   ConditionsSet  condition types (CondType / CondTypeDesc), read unfiltered like the sales order
	//                  app. Only the types in CONDITION_TYPES are offered (each needs its key
	//                  combinations and value kind); when the backend returns none of them the FDD list
	//                  is used and conditionTypesSource is "fallback".
	// init() checks the service metadata: while an entity set is missing, drafts and configuration
	// edits stay in this browser session only and every S/4 save is refused with a clear message
	// (§13: no false success; retain client draft and allow retry).
	//
	// Property names are mapped once in FIELD / CONFIG_FIELD so they can follow the final backend.

	var CONDITION_SET = "/CampaignConditionSet";
	var CONFIG_SET = "/CampaignPricingConfigSet";
	var BRAND_SET = "/BrandSet";
	var CONDITION_TYPE_SET = "/ConditionsSet";

	// Row property -> CampaignConditionSet property (§9 SaveBatch item DTO).
	var FIELD = {
		rowId: "ClientRowId",
		campaignId: "CampaignId",
		conditionType: "ConditionType",     // KSCHL
		combination: "AccessCombination",   // COMB_ID
		salesOrg: "SalesOrganization",      // VKORG
		distChannel: "DistributionChannel", // VTWEG
		customer: "Customer",               // KUNNR
		article: "Article",                 // MATNR
		hierarchy: "Hierarchy",
		brand: "Brand",                     // hierarchy node, WRF_BRANDS
		rate: "Rate",                       // KBETR, sent as a decimal string
		rateUnit: "RateUnit",               // currency or PERCENT
		pricingUnit: "PricingUnit",         // KPEIN (ZSRP)
		uom: "UnitOfMeasure",               // KMEIN (ZSRP)
		validFrom: "ValidFrom",             // DATAB, YYYYMMDD
		validTo: "ValidTo",                 // DATBI, YYYYMMDD
		tableNo: "ConditionTableNumber",    // KOTABNR snapshot (§22)
		recordNo: "ConditionRecordNo",      // KNUMH
		createdBy: "CreatedBy",
		createdOn: "CreatedAt"
	};

	// Configuration entry -> CampaignPricingConfigSet property (§21.2 payload).
	var CONFIG_FIELD = {
		conditionType: "ConditionType",
		combination: "CombinationId",
		tableNo: "ConditionTableNumber",
		fieldSet: "FieldSet",
		active: "Active",
		isDefault: "Default",
		validation: "ValidationStatus"
	};

	// Logical key combinations (§19). Every combination also carries Sales Org, Distribution Channel
	// and the Campaign ID ("ID" / "Campaign" in VK11 are the same business value).
	var COMBINATIONS = {
		KC01: { fields: ["customer", "article"], fieldSet: "CAMPAIGN_CUSTOMER_ARTICLE" },
		KC02: { fields: ["article"], fieldSet: "CAMPAIGN_ARTICLE" },
		KC03: { fields: ["brand"], fieldSet: "CAMPAIGN_BRAND" },
		KC04: { fields: ["brand", "customer"], fieldSet: "CAMPAIGN_BRAND_CUSTOMER" },
		KC05: { fields: ["customer"], fieldSet: "CAMPAIGN_CUSTOMER" },
		KC06: { fields: [], fieldSet: "CAMPAIGN" }
	};

	// Condition types (§2, §3). kind: price = amount + currency + pricing unit; amount = amount +
	// currency; percent = percentage.
	var CONDITION_TYPES = {
		ZSRP: { kind: "price", level: "item", combinations: ["KC01", "KC02"] },
		ZVHR: { kind: "amount", level: "item", combinations: ["KC01", "KC02", "KC03", "KC04", "KC05"] },
		ZCVO: { kind: "amount", level: "header", combinations: ["KC03", "KC05", "KC06"] },
		ZPWP: { kind: "percent", level: "item", combinations: ["KC01", "KC02", "KC03", "KC04", "KC05"] },
		ZPW1: { kind: "percent", level: "header", combinations: ["KC01", "KC02", "KC03", "KC04", "KC05"] }
	};

	var DEFAULT_DIST_CHANNEL = "10"; // §2, editable only if authorized (checked in S/4)
	var DEFAULT_HIERARCHY = "L2";    // §2, brand combinations
	var PERCENT = "%";

	// Condition currency proposed from the campaign country (Luxasia markets, see campaignService).
	var COUNTRY_CURRENCY = {
		SG: "SGD", MY: "MYR", TH: "THB", PH: "PHP", VN: "VND", ID: "IDR",
		IN: "INR", AU: "AUD", HK: "HKD", TW: "TWD", CN: "CNY"
	};

	// Row status (app-level, §2 "Activation": not a standard SAP condition status).
	var STATUS = {
		DRAFT: "Draft",
		ERROR: "Error",
		SAVED: "Saved",
		FAILED: "Failed"
	};

	var STATUS_STATE = {
		"Draft": "Information",
		"Error": "Error",
		"Saved": "Success",
		"Failed": "Error"
	};

	// Configuration validation status (§20 / §21.1), set by the S/4 backend only.
	var VALIDATION = {
		NOT_VALIDATED: "NotValidated",
		VALID: "Valid",
		INVALID: "Invalid"
	};

	var _oComponent = null;
	var _oModel = null;
	var _pInit = null;
	var _pBrands = null;
	var _pTypes = null;
	var _iRowSeq = 0;
	var _mAvailable = { conditions: false, config: false };

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

	// SAP Gateway error body -> messages (same parsing as campaignService).
	function _fromODataError(oError) {
		var aMsg = [];
		try {
			var oBody = JSON.parse(oError.responseText).error;
			((oBody.innererror && oBody.innererror.errordetails) || []).forEach(function (d) {
				if (d.severity !== "info") {
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

	// ---------------------------------------------------------------- backend calls

	function _main() {
		return _oComponent.getModel("mainModel");
	}

	function _read(sPath, mParameters) {
		return new Promise(function (resolve, reject) {
			_main().read(sPath, Object.assign({}, mParameters, {
				success: function (oData) { resolve(oData.results || oData); },
				error: function (oError) { reject(_fromODataError(oError)); }
			}));
		});
	}

	function _post(sSet, oPayload) {
		return new Promise(function (resolve, reject) {
			_main().create(sSet, oPayload, {
				success: function (oData) { resolve(oData || {}); },
				error: function (oError) { reject(_fromODataError(oError)); }
			});
		});
	}

	function _merge(sPath, oPayload) {
		return new Promise(function (resolve, reject) {
			_main().update(sPath, oPayload, {
				merge: true,
				success: function (oData) { resolve(oData || {}); },
				error: function (oError) { reject(_fromODataError(oError)); }
			});
		});
	}

	// Which of the proposed entity sets the deployed service exposes.
	function _detectServices() {
		var oMetaModel = _main().getMetaModel();
		return oMetaModel.loaded().then(function () {
			var oContainer = oMetaModel.getODataEntityContainer() || {};
			var aSets = (oContainer.entitySet || []).map(function (s) { return "/" + s.name; });
			_mAvailable.conditions = aSets.indexOf(CONDITION_SET) !== -1;
			_mAvailable.config = aSets.indexOf(CONFIG_SET) !== -1;
			_oModel.setProperty("/available", Object.assign({}, _mAvailable));
		});
	}

	// ---------------------------------------------------------------- dates

	function _day(d) {
		return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
	}

	function _toYmd(d) {
		if (!d) {
			return "";
		}
		return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
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

	// ---------------------------------------------------------------- configuration (§18, §19)

	// The 20 approved condition-type / combination mappings; Axxx numbers stay empty until the
	// SD team configures them (Addendum v1.1: never hardcode or infer table numbers).
	function _defaultConfigs() {
		var aConfigs = [];
		Object.keys(CONDITION_TYPES).forEach(function (sType) {
			CONDITION_TYPES[sType].combinations.forEach(function (sComb, i) {
				aConfigs.push({
					conditionType: sType,
					combination: sComb,
					fieldSet: COMBINATIONS[sComb].fieldSet,
					tableNo: "",
					active: true,
					isDefault: i === 0,
					validation: VALIDATION.NOT_VALIDATED,
					dirty: false
				});
			});
		});
		return aConfigs;
	}

	function _configFromBackend(r) {
		return {
			conditionType: r[CONFIG_FIELD.conditionType],
			combination: r[CONFIG_FIELD.combination],
			fieldSet: r[CONFIG_FIELD.fieldSet] || (COMBINATIONS[r[CONFIG_FIELD.combination]] || {}).fieldSet || "",
			tableNo: r[CONFIG_FIELD.tableNo] === "TBD" ? "" : (r[CONFIG_FIELD.tableNo] || ""),
			active: !!r[CONFIG_FIELD.active],
			isDefault: !!r[CONFIG_FIELD.isDefault],
			validation: r[CONFIG_FIELD.validation] || VALIDATION.NOT_VALIDATED,
			dirty: false
		};
	}

	// Backend rows replace the matching catalogue entries; combinations outside the approved
	// catalogue are ignored.
	function _loadConfigs() {
		var aConfigs = _defaultConfigs();
		if (!_mAvailable.config) {
			_oModel.setProperty("/configs", aConfigs);
			return Promise.resolve();
		}
		return _read(CONFIG_SET).then(function (aRows) {
			aRows.map(_configFromBackend).forEach(function (o) {
				var i = aConfigs.findIndex(function (c) {
					return c.conditionType === o.conditionType && c.combination === o.combination;
				});
				if (i !== -1) {
					aConfigs[i] = o;
				}
			});
			_oModel.setProperty("/configs", aConfigs);
		});
	}

	function _configs() {
		return _oModel.getProperty("/configs") || [];
	}

	function getConfig(sType, sComb) {
		return _configs().find(function (c) {
			return c.conditionType === sType && c.combination === sComb;
		}) || null;
	}

	// Active combinations for a condition type in catalogue order (CFG-006: inactive ones are not
	// offered for new records); the default one is the proposal.
	function combinationsFor(sType) {
		return ((CONDITION_TYPES[sType] || {}).combinations || []).filter(function (sComb) {
			var oCfg = getConfig(sType, sComb);
			return oCfg && oCfg.active;
		});
	}

	function defaultCombination(sType) {
		var aCombs = combinationsFor(sType);
		var sDefault = aCombs.find(function (sComb) { return getConfig(sType, sComb).isDefault; });
		return sDefault || aCombs[0] || "";
	}

	function tableName(sTableNo) {
		return sTableNo ? "A" + sTableNo : "";
	}

	// Local checks before the configuration goes to S/4; DDIC, access sequence and key-field checks
	// are backend-only (§21.1).
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

	function _fieldsOf(sComb) {
		return (COMBINATIONS[sComb] || {}).fields || [];
	}

	function _setStatus(oRow, sStatus, sMessage) {
		oRow.status = sStatus;
		oRow.statusState = STATUS_STATE[sStatus] || "None";
		oRow.message = sMessage || "";
	}

	function _rowFromBackend(r) {
		var oRow = {
			rowId: r[FIELD.rowId] || _nextRowId(),
			campaignId: r[FIELD.campaignId],
			conditionType: r[FIELD.conditionType],
			combination: r[FIELD.combination],
			salesOrg: r[FIELD.salesOrg] || "",
			distChannel: r[FIELD.distChannel] || "",
			customer: r[FIELD.customer] || "",
			article: r[FIELD.article] || "",
			hierarchy: r[FIELD.hierarchy] || "",
			brand: r[FIELD.brand] || "",
			rate: r[FIELD.rate] !== undefined && r[FIELD.rate] !== null ? String(r[FIELD.rate]) : "",
			rateUnit: r[FIELD.rateUnit] === "PERCENT" ? PERCENT : (r[FIELD.rateUnit] || ""),
			pricingUnit: r[FIELD.pricingUnit] ? String(r[FIELD.pricingUnit]) : "",
			uom: r[FIELD.uom] || "",
			validFrom: _parseDate(r[FIELD.validFrom]),
			validTo: _parseDate(r[FIELD.validTo]),
			tableNo: r[FIELD.tableNo] || "",
			recordNo: r[FIELD.recordNo] || "",
			createdBy: r[FIELD.createdBy] || "",
			createdOn: _parseDate(r[FIELD.createdOn])
		};
		_setStatus(oRow, STATUS.SAVED);
		return oRow;
	}

	// §9 item payload. Amounts go as decimal strings (no float rounding); only the key fields of the
	// selected combination are sent.
	function _payload(oRow) {
		var aFields = _fieldsOf(oRow.combination);
		var bPercent = CONDITION_TYPES[oRow.conditionType].kind === "percent";
		var o = {};
		o[FIELD.rowId] = oRow.rowId;
		o[FIELD.campaignId] = oRow.campaignId;
		o[FIELD.conditionType] = oRow.conditionType;
		o[FIELD.combination] = oRow.combination;
		o[FIELD.tableNo] = oRow.tableNo;
		o[FIELD.salesOrg] = oRow.salesOrg;
		o[FIELD.distChannel] = oRow.distChannel;
		if (aFields.indexOf("customer") !== -1) {
			o[FIELD.customer] = oRow.customer;
		}
		if (aFields.indexOf("article") !== -1) {
			o[FIELD.article] = oRow.article;
		}
		if (aFields.indexOf("brand") !== -1) {
			o[FIELD.hierarchy] = oRow.hierarchy;
			o[FIELD.brand] = oRow.brand;
		}
		o[FIELD.rate] = String(oRow.rate).trim();
		o[FIELD.rateUnit] = bPercent ? "PERCENT" : oRow.rateUnit;
		if (CONDITION_TYPES[oRow.conditionType].kind === "price") {
			o[FIELD.pricingUnit] = String(oRow.pricingUnit).trim();
			o[FIELD.uom] = oRow.uom;
		}
		o[FIELD.validFrom] = _toYmd(oRow.validFrom);
		o[FIELD.validTo] = _toYmd(oRow.validTo);
		return o;
	}

	// Same condition key = same type, combination, sales area and key field values.
	function _sameKey(a, b) {
		if (a.conditionType !== b.conditionType || a.combination !== b.combination ||
			a.campaignId !== b.campaignId || a.salesOrg !== b.salesOrg || a.distChannel !== b.distChannel) {
			return false;
		}
		return _fieldsOf(a.combination).every(function (f) { return a[f] === b[f]; });
	}

	function _overlaps(a, b) {
		return a.validFrom && a.validTo && b.validFrom && b.validTo &&
			a.validFrom <= b.validTo && b.validFrom <= a.validTo;
	}

	// §12 row validation. aOthers: the campaign's other rows, for the overlap check (§13: rejected
	// here; controlled delimitation of saved records is a separate action).
	function validateRow(oRow, aOthers) {
		var aMsg = [];
		var oType = CONDITION_TYPES[oRow.conditionType];
		var aFields = _fieldsOf(oRow.combination);
		if (!oRow.campaignId) {
			aMsg.push(_err("Campaign ID is mandatory.", "campaignId"));
		}
		if (!oType) {
			aMsg.push(_err("Select a condition type.", "conditionType"));
			return aMsg;
		}
		if (oType.combinations.indexOf(oRow.combination) === -1) {
			aMsg.push(_err("Select a key combination allowed for " + oRow.conditionType + ".", "combination"));
			return aMsg;
		}
		var oCfg = getConfig(oRow.conditionType, oRow.combination);
		if (!oCfg || !oCfg.active) {
			aMsg.push(_err(oRow.conditionType + " " + oRow.combination + " is not an active key combination.", "combination"));
		}
		if (!/^[A-Z0-9]{4}$/.test(oRow.salesOrg || "")) {
			aMsg.push(_err("Sales organization is mandatory (4 characters).", "salesOrg"));
		}
		if (!/^[A-Z0-9]{2}$/.test(oRow.distChannel || "")) {
			aMsg.push(_err("Distribution channel is mandatory (2 characters).", "distChannel"));
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
			if (oRow.hierarchy !== DEFAULT_HIERARCHY) {
				aMsg.push(_err("Hierarchy must be " + DEFAULT_HIERARCHY + " for brand combinations.", "hierarchy"));
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
		if (!aMsg.length) {
			var oClash = (aOthers || []).find(function (o) {
				return o.rowId !== oRow.rowId && _sameKey(o, oRow) && _overlaps(o, oRow);
			});
			if (oClash) {
				aMsg.push(_err("Validity overlaps " + (oClash.recordNo ? "condition record " + oClash.recordNo :
					"draft row " + oClash.rowId) + " with the same condition key.", "validFrom"));
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
		var aFields = _fieldsOf(o.combination);
		["customer", "article", "brand"].forEach(function (k) {
			if (aFields.indexOf(k) === -1) {
				o[k] = "";
			}
		});
		if (aFields.indexOf("brand") === -1) {
			o.hierarchy = "";
		}
		var oType = CONDITION_TYPES[o.conditionType];
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

	// Posting needs an active mapping with a condition table number (Addendum v1.1 §21).
	function _mappingError(oRow) {
		var oCfg = getConfig(oRow.conditionType, oRow.combination);
		if (!oCfg || !oCfg.active || !oCfg.tableNo) {
			return _err("No active condition table (Axxx) is configured for " + oRow.conditionType + " " +
				oRow.combination + "; posting is blocked until the SD team maintains it.", "combination");
		}
		return null;
	}

	function _validateOpen(sCampaignId) {
		var aAll = conditionsOf(sCampaignId);
		var aOpen = aAll.filter(function (o) { return o.status !== STATUS.SAVED; });
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

	function _refresh() {
		_oModel.refresh(true);
	}

	// ---------------------------------------------------------------- public API

	return {
		STATUS: STATUS,
		STATUS_STATE: STATUS_STATE,
		VALIDATION: VALIDATION,
		COMBINATIONS: COMBINATIONS,
		CONDITION_TYPES: CONDITION_TYPES,
		DEFAULT_DIST_CHANNEL: DEFAULT_DIST_CHANNEL,
		DEFAULT_HIERARCHY: DEFAULT_HIERARCHY,
		PERCENT: PERCENT,

		// Detects the backend entity sets and loads the Axxx configuration once.
		init: function (oComponent) {
			_oComponent = oComponent;
			if (!_oModel) {
				_oModel = new JSONModel({ conditions: [], configs: _defaultConfigs(), brands: [], available: {} });
			}
			if (!_pInit) {
				_pInit = _detectServices().then(_loadConfigs).catch(function (oError) {
					_pInit = null;
					throw oError;
				});
			}
			return _pInit;
		},

		getModel: function () {
			return _oModel;
		},

		isAvailable: function (sService) {
			return !!_mAvailable[sService];
		},

		combinationsFor: combinationsFor,
		defaultCombination: defaultCombination,
		getConfig: getConfig,
		tableName: tableName,
		validateRow: validateRow,
		validateConfigs: validateConfigs,
		conditionsOf: conditionsOf,

		currencyFor: function (sCountry) {
			return COUNTRY_CURRENCY[sCountry] || "";
		},

		// A new draft with the §2 / §17 defaults: Campaign ID, DC 10, Hierarchy L2, currency from country.
		newDraft: function (sCampaignId, sCountry, sType, sComb) {
			var sConditionType = CONDITION_TYPES[sType] ? sType : "ZPWP";
			var bPercent = CONDITION_TYPES[sConditionType].kind === "percent";
			return {
				campaignId: sCampaignId,
				conditionType: sConditionType,
				combination: sComb || defaultCombination(sConditionType),
				salesOrg: "",
				distChannel: DEFAULT_DIST_CHANNEL,
				customer: "",
				article: "",
				hierarchy: DEFAULT_HIERARCHY,
				brand: "",
				rate: "",
				rateUnit: bPercent ? PERCENT : (COUNTRY_CURRENCY[sCountry] || ""),
				pricingUnit: "1",
				uom: "EA",
				validFrom: null,
				validTo: null
			};
		},

		// Records already linked to the campaign in S/4 replace the campaign's saved rows; local
		// drafts and failed rows stay so they can be retried.
		loadConditions: function (sCampaignId) {
			if (!_mAvailable.conditions) {
				return Promise.resolve(conditionsOf(sCampaignId));
			}
			return _read(CONDITION_SET, {
				filters: [new Filter(FIELD.campaignId, FilterOperator.EQ, sCampaignId)]
			}).then(function (aData) {
				var aSaved = aData.filter(function (r) { return r[FIELD.campaignId] === sCampaignId; }).map(_rowFromBackend);
				var aKeep = _rows().filter(function (o) {
					return o.campaignId !== sCampaignId || o.status !== STATUS.SAVED;
				});
				_setRows(aKeep.concat(aSaved));
				return conditionsOf(sCampaignId);
			});
		},

		// Adds a validated draft row; rejects with field messages otherwise.
		addDraft: function (oDraft) {
			var oRow = _normalize(oDraft);
			var aMsg = validateRow(oRow, conditionsOf(oRow.campaignId));
			if (aMsg.length) {
				return Promise.reject(_throw(aMsg));
			}
			oRow.rowId = _nextRowId();
			oRow.tableNo = "";
			oRow.recordNo = "";
			_setStatus(oRow, STATUS.DRAFT);
			_setRows(_rows().concat([oRow]));
			return Promise.resolve(oRow);
		},

		// Only rows not yet saved in S/4 can be removed; saved records are delimited instead.
		removeDraft: function (sRowId) {
			_setRows(_rows().filter(function (o) {
				return o.rowId !== sRowId || o.status === STATUS.SAVED;
			}));
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

		// §4.2 / §13 save: validates open rows, then posts each valid row on its own so one failure
		// does not roll back the others. Successful rows keep their KNUMH and are never posted again;
		// failed rows can be retried. A success without a record number counts as failed.
		save: function (sCampaignId) {
			var aValid = _validateOpen(sCampaignId).filter(function (o) { return o.status !== STATUS.ERROR; });
			if (!aValid.length) {
				_refresh();
				return Promise.resolve({ saved: 0, failed: 0, errors: conditionsOf(sCampaignId).filter(function (o) {
					return o.status === STATUS.ERROR;
				}).length });
			}
			if (!_mAvailable.conditions) {
				_refresh();
				return Promise.reject(_throw(_err("The pricing condition service (" + CONDITION_SET.slice(1) +
					") is not available in ZSDGW_CE_APP_SRV yet. Nothing was posted to S/4; the draft rows are kept in this session.")));
			}
			var aPost = [];
			aValid.forEach(function (oRow) {
				var oMappingErr = _mappingError(oRow);
				if (oMappingErr) {
					_setStatus(oRow, STATUS.ERROR, oMappingErr.text);
					return;
				}
				oRow.tableNo = getConfig(oRow.conditionType, oRow.combination).tableNo;
				aPost.push(oRow);
			});
			return Promise.allSettled(aPost.map(function (oRow) {
				return _post(CONDITION_SET, _payload(oRow)).then(function (oData) {
					if (!oData[FIELD.recordNo]) {
						throw _throw(_err("No condition record number was returned."));
					}
					oRow.recordNo = oData[FIELD.recordNo];
					oRow.createdBy = oData[FIELD.createdBy] || "";
					oRow.createdOn = _parseDate(oData[FIELD.createdOn]) || _day(new Date());
					_setStatus(oRow, STATUS.SAVED);
				});
			})).then(function (aResults) {
				aResults.forEach(function (r, i) {
					if (r.status === "rejected") {
						_setStatus(aPost[i], STATUS.FAILED, r.reason.message);
					}
				});
				_refresh();
				var aAll = conditionsOf(sCampaignId);
				return {
					saved: aResults.filter(function (r) { return r.status === "fulfilled"; }).length,
					failed: aResults.filter(function (r) { return r.status === "rejected"; }).length,
					errors: aAll.filter(function (o) { return o.status === STATUS.ERROR; }).length
				};
			});
		},

		// §4.3 change/delimit: only the Valid To of a saved record changes (never a full overwrite).
		delimit: function (sRowId, oNewTo) {
			var oRow = _rows().find(function (o) { return o.rowId === sRowId; });
			var oTo = _day(oNewTo);
			if (!oRow || oRow.status !== STATUS.SAVED || !oRow.recordNo) {
				return Promise.reject(_throw(_err("Only condition records saved in S/4 can be delimited.")));
			}
			if (!oTo || (oRow.validFrom && oTo < oRow.validFrom)) {
				return Promise.reject(_throw(_err("The new Valid To cannot be before Valid From.", "validTo")));
			}
			if (oRow.validTo && oTo > oRow.validTo) {
				return Promise.reject(_throw(_err("Delimiting can only shorten the validity.", "validTo")));
			}
			if (!_mAvailable.conditions) {
				return Promise.reject(_throw(_err("The pricing condition service is not available yet; the record was not changed.")));
			}
			var oKey = {};
			oKey[FIELD.recordNo] = oRow.recordNo;
			var oPayload = {};
			oPayload[FIELD.validTo] = _toYmd(oTo);
			return _merge(_main().createKey(CONDITION_SET, oKey), oPayload).then(function () {
				oRow.validTo = oTo;
				_refresh();
				return oRow;
			});
		},

		// Brand value help (WRF_BRANDS via BrandSet), for the selected store when there is one. Any
		// failure leaves the list empty: the brand can still be typed and S/4 validates it.
		loadBrands: function (sStoreId) {
			if (!_pBrands) {
				var aFilters = sStoreId ? [new Filter("StoreId", FilterOperator.EQ, sStoreId)] : [];
				_pBrands = _read(BRAND_SET, { filters: aFilters, urlParameters: { $top: 5000 } }).then(function (aBrands) {
					var mSeen = {};
					_oModel.setProperty("/brands", aBrands.filter(function (b) {
						var bNew = b.BrandId && !mSeen[b.BrandId];
						mSeen[b.BrandId] = true;
						return bNew;
					}).map(function (b) {
						return { key: b.BrandId, text: b.BrandDesc || b.BrandId };
					}));
				}).catch(function () {
					_oModel.setProperty("/brands", []);
				});
			}
			return _pBrands;
		},

		// Condition types for the dropdown: [{ key, text }] with the backend description; resolves
		// with the FDD list when ConditionsSet cannot be read or returns none of the supported types.
		loadConditionTypes: function () {
			if (!_pTypes) {
				_pTypes = _read(CONDITION_TYPE_SET).then(function (aRows) {
					var mText = {};
					aRows.forEach(function (r) {
						var sKey = (r.CondType || "").trim().toUpperCase();
						if (CONDITION_TYPES[sKey] && !mText[sKey]) {
							mText[sKey] = r.CondTypeDesc || "";
						}
					});
					return mText;
				}).catch(function () {
					return {};
				}).then(function (mText) {
					var aKeys = Object.keys(CONDITION_TYPES).filter(function (k) { return k in mText; });
					_oModel.setProperty("/conditionTypesSource", aKeys.length ? "backend" : "fallback");
					_oModel.setProperty("/conditionTypes", (aKeys.length ? aKeys : Object.keys(CONDITION_TYPES)).map(function (k) {
						return { key: k, text: mText[k] || "" };
					}));
					return _oModel.getProperty("/conditionTypes");
				});
			}
			return _pTypes;
		},

		// Backend description of a condition type ("" when not loaded or not returned).
		conditionTypeText: function (sType) {
			var oType = ((_oModel && _oModel.getProperty("/conditionTypes")) || []).find(function (t) { return t.key === sType; });
			return oType ? oType.text : "";
		},

		// Sends changed mappings to S/4, which validates DDIC / access sequence / key fields and
		// returns the validation status (§20 Save + Validate; activation is decided by the backend).
		saveConfigs: function () {
			var aMsg = validateConfigs().filter(function (m) { return m.type === "Error"; });
			if (aMsg.length) {
				return Promise.reject(_throw(aMsg));
			}
			var aDirty = _configs().filter(function (c) { return c.dirty; });
			if (!aDirty.length) {
				return Promise.resolve({ saved: 0, failed: 0 });
			}
			if (!_mAvailable.config) {
				return Promise.reject(_throw(_err("The pricing configuration service (" + CONFIG_SET.slice(1) +
					") is not available in ZSDGW_CE_APP_SRV yet. The changes were not saved to S/4 and only apply in this session.")));
			}
			return Promise.allSettled(aDirty.map(function (c) {
				var o = {};
				o[CONFIG_FIELD.conditionType] = c.conditionType;
				o[CONFIG_FIELD.combination] = c.combination;
				o[CONFIG_FIELD.tableNo] = c.tableNo;
				o[CONFIG_FIELD.fieldSet] = c.fieldSet;
				o[CONFIG_FIELD.active] = c.active;
				o[CONFIG_FIELD.isDefault] = c.isDefault;
				return _post(CONFIG_SET, o).then(function (oData) {
					Object.assign(c, _configFromBackend(Object.assign({}, o, oData)));
				});
			})).then(function (aResults) {
				_refresh();
				var aFailed = [];
				aResults.forEach(function (r, i) {
					if (r.status === "rejected") {
						aDirty[i].validation = VALIDATION.INVALID;
						aFailed.push(aDirty[i].conditionType + " " + aDirty[i].combination + ": " + r.reason.message);
					}
				});
				return { saved: aResults.length - aFailed.length, failed: aFailed.length, messages: aFailed };
			});
		},

		// Marks a configuration entry as edited locally (validation status resets until S/4 checks it).
		markConfigChanged: function (oConfig) {
			oConfig.dirty = true;
			oConfig.validation = VALIDATION.NOT_VALIDATED;
		},

		// Test hook: drop all session state.
		_reset: function () {
			_oModel = null;
			_pInit = null;
			_pBrands = null;
			_pTypes = null;
			_iRowSeq = 0;
			_mAvailable = { conditions: false, config: false };
		},

		// Test hook: a model without a backend (validation / draft logic only).
		_initLocal: function () {
			_oModel = new JSONModel({ conditions: [], configs: _defaultConfigs(), brands: [], available: {} });
		}
	};
});
