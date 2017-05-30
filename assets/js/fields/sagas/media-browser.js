/**
 * The external dependencies.
 */
import { takeEvery, take, call, put, select, all } from 'redux-saga/effects';
import { isEmpty, isNull, isUndefined, first, filter, last } from 'lodash';

/**
 * The internal dependencies.
 */
import { createMediaBrowserChannel } from 'lib/events';
import { getFieldById, getComplexGroupById, getFieldParentById } from 'fields/selectors';
import { getAttachmentThumbnail } from 'fields/helpers';
import {
	setupMediaBrowser,
	openMediaBrowser,
	updateField,
	setFieldValue,
	addComplexGroup,
	receiveComplexGroup,
	addMultipleFiles,
} from 'fields/actions';

/**
 * Add complex groups for every additional attachment selected in the media browser
 *
 * @param  {Object} action
 * @return {void}
 */
export function* workerAddMultipleFiles(action) {
	const { fieldId, attachments } = action.payload;
	const field = yield select(getFieldById, fieldId);
	const parent = yield select(getComplexGroupById, field.parent);
	if (isUndefined(parent)) {
		return;
	}

	for (let i = 0; i < attachments.length; i++) {
		const attachment = attachments[i];
		// add a new group to hold the attachment
		yield put(addComplexGroup(parent.field.id, parent.group.name));

		// pause until the complex is updated
		yield take(receiveComplexGroup);
		
		// resolve the new field from the new group and assign it's new value
		const parentField = yield select(getFieldById, parent.field.id);
		const freshGroup = last(parentField.value);
		const freshFieldId = first(filter(freshGroup.fields, f => f.base_name === field.base_name)).id;
		const freshField = yield select(getFieldById, freshFieldId);

		yield redrawAttachmentPreview(freshField.id, attachment, freshField.default_thumb_url);
		yield put(setFieldValue(freshField.id, attachment.id));
	}
}

/**
 * Trigger a preview redraw action based on an attachment
 *
 * @param  {Object} fieldId
 * @param  {Object} attachment
 * @param  {String} default_thumb_url
 * @return {void}
 */
export function* redrawAttachmentPreview(fieldId, attachment, default_thumb_url) {
	if (!isNull(attachment)) {
		const thumbnail = yield call(getAttachmentThumbnail, attachment);
		yield put(updateField(fieldId, {
			file_name: attachment.filename,
			file_url: attachment.url,
			thumb_url: thumbnail || default_thumb_url,
			preview: attachment.id,
		}));
	} else {
		yield put(updateField(fieldId, {
			file_name: '',
			file_url: '',
			thumb_url: '',
			preview: '',
		}));
	}
}

/**
 * Redraw an attachment preview.
 *
 * @param  {Object} field
 * @param  {Object} action
 * @return {void}
 */
export function* workerRedrawAttachmentPreview(field, action) {
	const {fieldId, value} = action.payload;

	// Don't update the preview if the field doesn't have correct id.
	if (fieldId !== field.id) {
		return;
	}

	// Don't waste time trying to load an already loaded preview
	const freshField = yield select(getFieldById, field.id);
	if (freshField.preview === value) {
		return;
	}

	let attachment = null;
	if (value) {
		attachment = yield window.wp.media.attachment(value).fetch();
	}
	yield redrawAttachmentPreview(fieldId, attachment, field.default_thumb_url);
}

/**
 * Handle the interaction with media browser of WordPress.
 *
 * @param  {Object} channel
 * @param  {Object} field
 * @param  {Object} browser
 * @param  {Object} action
 * @return {void}
 */
export function* workerOpenMediaBrowser(channel, field, browser, action) {
	// Don't open the browser if the field doesn't have correct id.
	if (action.payload !== field.id) {
		return;
	}

	const liveField = yield select(getFieldById, action.payload);
	browser.once('open', (function(value) {
		var attachment = value ? window.wp.media.attachment(value) : null;
		browser.state().get('selection').set( attachment ? [attachment] : [] );
	}).bind(null, liveField.value));

	yield call([browser, browser.open]);

	while (true) {
		const { selection } = yield take(channel);
		const [ attachment, ...attachments ] = selection;
		
		yield redrawAttachmentPreview(field.id, attachment, field.default_thumb_url);
		yield put(setFieldValue(field.id, attachment.id));

		if (!isEmpty(attachments)) {
			yield put(addMultipleFiles(field.id, attachments));
		}
	}
}

/**
 * Initial setup of the media browser.
 *
 * @param  {Object} action
 * @return {void}
 */
export function* workerSetupMediaBrowser(action) {
	const field = yield select(getFieldById, action.payload);
	const {
		window_button_label,
		window_label,
		type_filter,
		value_type
	} = field;

	const channel = yield call(createMediaBrowserChannel, {
		title: window_label,
		library: {
			type: type_filter
		},
		button: {
			text: window_button_label
		},
		multiple: true
	});

	const { browser } = yield take(channel);

	yield takeEvery(openMediaBrowser, workerOpenMediaBrowser, channel, field, browser);
	yield takeEvery(setFieldValue, workerRedrawAttachmentPreview, field);
}

/**
 * Start to work.
 *
 * @return {void}
 */
export default function* foreman() {
	yield all([
		takeEvery(setupMediaBrowser, workerSetupMediaBrowser),
		takeEvery(addMultipleFiles, workerAddMultipleFiles),
	]);
}
