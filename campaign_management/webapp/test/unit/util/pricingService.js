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

	QUnit.module("pricingService", {
		beforeEach: function () {
			pricingService._reset();
			pricingService._initLocal();
		}
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

	QUnit.test("Overlapping validity for the same key is rejected", function (assert) {
		var done = assert.async();
		pricingService.addDraft(draft()).then(function () {
			return pricingService.addDraft(draft({ validFrom: new Date(2026, 10, 15), validTo: new Date(2026, 11, 15) }));
		}).then(function () {
			assert.ok(false, "overlap accepted");
		}, function (oError) {
			assert.strictEqual(oError.messages[0].field, "validFrom");
			return pricingService.addDraft(draft({ article: "SKU2002" }));
		}).then(function () {
			assert.strictEqual(pricingService.conditionsOf("C-00001232").length, 2, "other article is accepted");
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
