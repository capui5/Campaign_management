/*global QUnit*/

sap.ui.define([
	"com/luxasia/campaignmanagement/util/pricingService"
], function (pricingService) {
	"use strict";

	function draft(oOverrides) {
		return Object.assign(pricingService.newDraft("C-00001232", "MY", "ZPWP", "KC02"), {
			salesOrg: "MY01",
			article: "SKU1001",
			rate: "30",
			validFrom: new Date(2026, 10, 1),
			validTo: new Date(2026, 10, 30)
		}, oOverrides);
	}

	function fields(aMsg) {
		return aMsg.map(function (m) { return m.field; });
	}

	// Catalogue fixture: the CAP mock data, expanded like the service response
	// (ConditionTypeKeyCombinations?$expand=CONDITION_TYPE,KEY_COMBINATION($expand=BUSINESS_KEYS)).
	var DATA = "com/luxasia/campaignmanagement/localService/oDataV4/data/";
	var oCatalog = null;

	function loadJson(sName) {
		return fetch(sap.ui.require.toUrl(DATA + sName + ".json")).then(function (oResponse) {
			return oResponse.json();
		});
	}

	function loadCatalog() {
		return Promise.all(["ConditionTypes", "KeyCombinations", "BusinessKeys", "ConditionTypeKeyCombinations"].map(loadJson))
			.then(function (a) {
				var aTypes = a[0].filter(function (t) { return t.IS_ACTIVE; });
				var mTypes = {};
				var mCombs = {};
				aTypes.forEach(function (t) { mTypes[t.ID] = t; });
				a[1].forEach(function (c) {
					mCombs[c.ID] = Object.assign({}, c, {
						BUSINESS_KEYS: a[2].filter(function (k) { return k.KEY_COMBINATION_ID === c.ID; })
					});
				});
				var aRows = a[3].filter(function (r) { return mTypes[r.CONDITION_TYPE_ID]; }).map(function (r) {
					return Object.assign({}, r, { CONDITION_TYPE: mTypes[r.CONDITION_TYPE_ID], KEY_COMBINATION: mCombs[r.KEY_COMBINATION_ID] });
				});
				oCatalog = { types: aTypes, rows: aRows };
			});
	}

	QUnit.module("pricingService", {
		before: function () {
			return loadCatalog();
		},
		beforeEach: function () {
			pricingService._reset();
			pricingService._initLocal(oCatalog.types, oCatalog.rows);
		}
	});

	QUnit.test("Condition types come only from the service, in its order", function (assert) {
		assert.deepEqual(pricingService.conditionTypes(), ["ZSRP", "ZVHR", "ZCVO", "ZPWP", "ZPW1"]);
		assert.strictEqual(pricingService.conditionTypeText("ZVHR"), "Item Amount Discount");
		pricingService._reset();
		pricingService._initLocal([], []);
		assert.deepEqual(pricingService.conditionTypes(), [], "no hardcoded types without backend data");
		assert.deepEqual(pricingService.getModel().getProperty("/configs"), []);
	});

	QUnit.test("Catalogue has the 20 approved mappings", function (assert) {
		assert.strictEqual(pricingService.getModel().getProperty("/configs").length, 20);
		assert.deepEqual(pricingService.combinationsFor("ZCVO"), ["KC03", "KC05", "KC06"]);
		assert.strictEqual(pricingService.defaultCombination("ZSRP"), "KC01");
	});

	QUnit.test("Defaults: DC 10, hierarchy L2, currency from country", function (assert) {
		var o = pricingService.newDraft("C-1", "SG", "ZVHR", "KC03");
		assert.strictEqual(o.distChannel, "10");
		assert.strictEqual(o.hierarchy, "L2");
		assert.strictEqual(o.rateUnit, "SGD");
		assert.strictEqual(pricingService.newDraft("C-1", "SG", "ZPW1").rateUnit, "%");
	});

	QUnit.test("Valid ZPWP campaign / article row", function (assert) {
		assert.strictEqual(pricingService.validateRow(draft(), []).length, 0);
	});

	QUnit.test("Key fields follow the combination", function (assert) {
		assert.deepEqual(fields(pricingService.validateRow(draft({ article: "" }), [])), ["article"]);
		var aMsg = pricingService.validateRow(draft({ combination: "KC04", article: "" }), []);
		assert.deepEqual(fields(aMsg).sort(), ["brand", "customer"]);
		assert.deepEqual(fields(pricingService.validateRow(draft({ conditionType: "ZSRP", combination: "KC03" }), [])), ["combination"]);
	});

	QUnit.test("Distribution channel is always the DIST_CHANNEL business key default", function (assert) {
		assert.strictEqual(pricingService.distChannelFor("KC06"), "10");
		assert.strictEqual(pricingService.newDraft("C-1", "SG", "ZCVO", "KC06").distChannel, "10");
		assert.deepEqual(fields(pricingService.validateRow(draft({ distChannel: "20" }), [])), ["distChannel"]);
		var done = assert.async();
		pricingService.addDraft(draft({ distChannel: "" })).then(function (oRow) {
			assert.strictEqual(oRow.distChannel, "10", "stored with the backend value");
		}).finally(done);
	});

	QUnit.test("FIELD_CODE DISTRIBUTION_CHANNEL (CAP service spelling) is the distribution channel", function (assert) {
		var oType = { ID: "t1", CONDITION_CODE: "ZSRP", DESCRIPTION: "Special Price", LEVEL: "ITEM", VALUE_KIND: "PRICE", IS_ACTIVE: true };
		pricingService._reset();
		pricingService._initLocal([oType], [{
			CONDITION_TYPE_ID: "t1", KEY_COMBINATION_ID: "k1", CONDITION_TABLE_NUMBER: null, DEFAULT_FLAG: true, IS_ACTIVE: true,
			CONDITION_TYPE: oType,
			KEY_COMBINATION: { ID: "k1", COMBINATION_CODE: "KC02", DESCRIPTION: "Sales Org / Distr. Chl / Campaign ID / Article", IS_ACTIVE: true,
				BUSINESS_KEYS: [
					{ FIELD_CODE: "DISTRIBUTION_CHANNEL", BUSINESS_KEY: "Distribution Channel", S4_FIELD: "VTWEG", SEQUENCE: 2, REQUIRED: true, DEFAULT_VALUE: "10" },
					{ FIELD_CODE: "ARTICLE_SKU", BUSINESS_KEY: "Article SKU", S4_FIELD: "MATNR", SEQUENCE: 4, REQUIRED: true, DEFAULT_VALUE: null }
				] }
		}]);
		assert.strictEqual(pricingService.distChannelFor("KC02"), "10");
		assert.deepEqual(pricingService.fieldsOf("KC02"), ["article"]);
	});

	QUnit.test("Hierarchy is always the HIERARCHY business key default for brand combinations", function (assert) {
		assert.strictEqual(pricingService.hierarchyFor("KC03"), "L2");
		assert.strictEqual(pricingService.hierarchyFor("KC02"), "", "no hierarchy without brand");
		assert.deepEqual(fields(pricingService.validateRow(draft({ combination: "KC03", brand: "DYS", hierarchy: "L3" }), [])), ["hierarchy"]);
		var done = assert.async();
		pricingService.addDraft(draft({ combination: "KC03", brand: "DYS", hierarchy: "" })).then(function (oRow) {
			assert.strictEqual(oRow.hierarchy, "L2", "stored with the backend value");
		}).finally(done);
	});

	QUnit.test("Dates, rate and percentage limits", function (assert) {
		assert.deepEqual(fields(pricingService.validateRow(draft({ validFrom: new Date(2026, 11, 1) }), [])), ["validTo"]);
		assert.deepEqual(fields(pricingService.validateRow(draft({ rate: "101" }), [])), ["rate"]);
		assert.deepEqual(fields(pricingService.validateRow(draft({ rate: "0" }), [])), ["rate"]);
		assert.deepEqual(fields(pricingService.validateRow(draft({ rate: "12.345" }), [])), ["rate"]);
	});

	QUnit.test("ZSRP needs currency, pricing unit and unit of measure", function (assert) {
		var o = draft({ conditionType: "ZSRP", rateUnit: "", pricingUnit: "0", uom: "" });
		assert.deepEqual(fields(pricingService.validateRow(o, [])).sort(), ["pricingUnit", "rateUnit", "uom"]);
	});

	QUnit.test("Overlapping validity is left to the backend (no UI check)", function (assert) {
		var done = assert.async();
		pricingService.addDraft(draft()).then(function () {
			return pricingService.addDraft(draft({ validFrom: new Date(2026, 10, 15), validTo: new Date(2026, 11, 15) }));
		}).then(function () {
			assert.strictEqual(pricingService.conditionsOf("C-00001232").length, 2, "overlapping draft sent on");
		}, function (oError) {
			assert.ok(false, "rejected in the UI: " + oError.message);
		}).finally(done);
	});

	QUnit.test("A loaded draft is changed in place, not added again", function (assert) {
		var done = assert.async();
		pricingService.addDraft(draft()).then(function (oRow) {
			return pricingService.updateDraft(oRow.rowId, draft({ rate: "15" })).then(function (oNew) {
				var aRows = pricingService.conditionsOf("C-00001232");
				assert.strictEqual(aRows.length, 1, "no second record");
				assert.strictEqual(oNew.rowId, oRow.rowId, "same record");
				assert.strictEqual(aRows[0].rate, "15", "changed value");
			});
		}).finally(done);
	});

	QUnit.test("Inactive combinations are not offered", function (assert) {
		pricingService.getConfig("ZPWP", "KC02").active = false;
		assert.strictEqual(pricingService.combinationsFor("ZPWP").indexOf("KC02"), -1);
		assert.deepEqual(fields(pricingService.validateRow(draft(), [])), ["combination"]);
	});

	QUnit.test("Configuration checks: 3-digit table number, one default per type", function (assert) {
		var aConfigs = pricingService.getModel().getProperty("/configs");
		pricingService.getConfig("ZPWP", "KC02").tableNo = "91";
		pricingService.getConfig("ZPWP", "KC03").isDefault = true;
		var aErrors = pricingService.validateConfigs(aConfigs).filter(function (m) { return m.type === "Error"; });
		assert.strictEqual(aErrors.length, 2);
	});

});
