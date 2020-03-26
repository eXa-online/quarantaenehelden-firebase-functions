const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const sgMail = require('@sendgrid/mail');
const { GeoCollectionReference } = require('geofirestore');

const envVariables = functions.config();
const sgMailApiKey = envVariables && envVariables.sendgrid && envVariables.sendgrid.key
   ? envVariables.sendgrid.key
   : null;
sgMail.setApiKey(sgMailApiKey);

const MAX_RESULTS = 30;
const MAPS_ENABLED = false;
const MINIMUM_NOTIFICATION_DELAY = 20; // minutes
const SEND_EMAILS = sgMailApiKey !== null;
const sendingMailsDisabledLogMessage = 'Sending emails is currently disabled.';

exports.offerHelpCreate = functions.region('europe-west1').firestore.document('/ask-for-help/{requestId}/offer-help/{offerId}')
  .onCreate(async (snap, context) => {
    try {
      const parentPath = snap.ref.parent.path; // get the id
      const offerId = snap.id; // get the id
      const db = admin.firestore();
      const askForHelp = snap.ref.parent.parent;

      const offer = await db.collection(parentPath).doc(offerId).get();
      const askRecord = await askForHelp.get();
      if (!askRecord.exists) {
        console.error('ask-for-help at ', snap.ref.parent.parent.path, 'does not exist');
        return;
      }
      const { request, uid } = askRecord.data().d; // TODO check for d
      const data = await admin.auth().getUser(uid);
      const { email: receiver } = data.toJSON();
      const { answer, email } = offer.data();

      console.log({
        to: receiver,
        from: email,
        subject: 'WirAlle RBL - Jemand hat dir geschrieben!',
        answer: answer,
        email: email,
        request: request,
      });
      try {
        if (SEND_EMAILS) {
          await sgMail.send({
            to: receiver,
            from: 'help@wiralle-rbl.com',
            subject: 'WirAlle RBL - Jemand hat dir geschrieben!',
            text: `Hallo,
jemand hat sich sich auf die folgende Anfrage von dir gemeldet:
"${request}"

Deine Helferin / dein Helfer lässt dir folgende Nachricht zukommen:
"${answer}"

Du kannst deiner Helferin / deinem Helfer nun unter folgender E-Mail Adresse antworten:
${email}`,
          });
        } else {
          console.log(sendingMailsDisabledLogMessage);
        }
      } catch (err) {
        console.warn(err);
        if (err.response && err.response.body && err.response.body.errors) {
          console.warn(err.response.body.errors);
        }
      }

      await db.collection(`/ask-for-help`).doc(askRecord.id).update({
        'd.responses': admin.firestore.FieldValue.increment(1),
      });
      await db.collection('/stats').doc('external').update({
        offerHelp: admin.firestore.FieldValue.increment(1),
      });
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.sendNotificationEmails = functions.region('europe-west1').pubsub.schedule('every 3 minutes').onRun(async (context) => {
  const dist = (search, doc) => {
    return Math.abs(Number(search) - Number(doc.plz));
  };

  const db = admin.firestore();

  const getEligibleHelpOffers = async (askForHelpSnapData) => {
    let queryResult = [];
    if (MAPS_ENABLED) {
      const offersRef = new GeoCollectionReference(db.collection('offer-help'));
      const query = offersRef.near({ center: askForHelpSnapData.coordinates, radius: 30 });
      queryResult = (await query.get()).docs.map(doc => doc.data());

    } else {
      const offersRef = db.collection('offer-help');
      if (!askForHelpSnapData || !askForHelpSnapData.d || !askForHelpSnapData.d.plz) {
        console.warn('Failed to find plz for ask-for-help ', askForHelpSnapData);
      } else {
        const search = askForHelpSnapData.d.plz;
        const start = search.slice(0, -3) + '000';
        const end = search.slice(0, -3) + '999';
        const results = await offersRef.orderBy('d.plz').startAt(start).endAt(end).get();
        const allPossibleOffers = results.docs.map(doc => ({ id: doc.id, ...doc.data().d })).filter(({ plz }) => plz.length === search.length);
        const sortedOffers = allPossibleOffers.map(doc => ({ ...doc, distance: dist(search, doc) })).sort((doc1, doc2) => {
          return doc1.distance - doc2.distance;
        });
        if (sortedOffers.length > MAX_RESULTS) {
          const lastEntry = sortedOffers[MAX_RESULTS];
          queryResult = sortedOffers.filter(doc => doc.distance <= lastEntry.distance);
        } else {
          queryResult = sortedOffers;
        }
      }
    }

    let offersToContact = [];
    if (queryResult.length > MAX_RESULTS) {
      for (let i = queryResult.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * i);
        const temp = queryResult[i];
        queryResult[i] = queryResult[j];
        queryResult[j] = temp;
      }
      offersToContact = queryResult.slice(0, MAX_RESULTS);
    } else {
      offersToContact = queryResult;
    }
    return offersToContact;
  };

  const sendNotificationEmails = async (eligibleHelpOffers, askForHelpSnapData, askForHelpId) => {
    console.log("Calling sendNotificationEmails");
    const result = await Promise.all(eligibleHelpOffers.map(async offerDoc => {
      try {
        const { uid } = offerDoc;
        const offeringUser = await admin.auth().getUser(uid);
        const { email } = offeringUser.toJSON();
        console.log({
          to: email,
          from: 'help@wiralle-rbl.com',
          subject: 'WirAlle RBL - Jemand braucht deine Hilfe!',
          text: `Hallo,
jemand aus deiner Region benötigt deine Hilfe! Sie / er wohnt in ${askForHelpSnapData.d.location} und hat folgendes geschrieben: 
"${askForHelpSnapData.d.request}"

Du kannst auf die Anfrage unter folgendem Link antworten:
${'https://www.wiralle-rbl.com/#/offer-help/' + askForHelpId}`,
        });
        await sgMail.send({
          to: email,
          from: 'help@wiralle-rbl.com',
          subject: 'WirAlle RBL - Jemand braucht deine Hilfe!',
          text: `Hallo,
jemand aus deiner Region benötigt deine Hilfe!
Sie / er wohnt in ${askForHelpSnapData.d.location} und hat folgendes geschrieben: 
"${askForHelpSnapData.d.request}"

Du kannst auf die Anfrage unter folgendem Link antworten:
${'https://www.wiralle-rbl.com/#/offer-help/' + askForHelpId}`,
        });

        await db.collection(`/ask-for-help`).doc(askForHelpId).update({
          'd.notificationCounter': admin.firestore.FieldValue.increment(1),
          'd.notificationReceiver': admin.firestore.FieldValue.arrayUnion(uid)
        });
        return {askForHelpId, email}
      } catch (err) {
        console.warn(err);
        if (err.response && err.response.body && err.response.body.errors) {
          console.warn(err.response.body.errors);
        }
        return null;
      }
    }));
    console.log(result);
  };

  try {
    const askForHelpSnaps = await db.collection('ask-for-help')
      .where('d.timestamp', '<=', Date.now() - MINIMUM_NOTIFICATION_DELAY * 60 * 1000)
      .where('d.notificationCounter', '==', 0)
      .limit(3)
      .get();

    console.log("askForHelp Requests to execute", askForHelpSnaps.docs.length);
    // RUN SYNC
    for (let i = 0; i < askForHelpSnaps.docs.length; i++) {
      const askForHelpSnap = askForHelpSnaps.docs[i];
      const askForHelpSnapData = askForHelpSnap.data();
      const askForHelpId = askForHelpSnap.id;
      const eligibleHelpOffers = await getEligibleHelpOffers(askForHelpSnapData);
      console.log("askForHelpId", askForHelpId);
      console.log("eligibleHelpOffers", eligibleHelpOffers.length);
      if (SEND_EMAILS) {
        await sendNotificationEmails(eligibleHelpOffers, askForHelpSnapData, askForHelpId);
      } else {
        console.log(sendingMailsDisabledLogMessage);
      }
    }

  } catch (e) {
    console.error(e);
  }

});

exports.askForHelpCreate = functions.region('europe-west1').firestore.document('/ask-for-help/{requestId}')
  .onCreate(async (snap, context) => {
    try {
      const db = admin.firestore();
      const askForHelpId = snap.id; // get the id
      const parentPath = snap.ref.parent.path; // get the id
      const askForHelpSnap = await db.collection(parentPath).doc(askForHelpId).get();
      const askForHelpSnapData = askForHelpSnap.data();

      // Enforce field to 0
      await snap.ref.update({
        'd.notificationCounter': 0
      });

      await db.collection('/stats').doc('external').update({
        askForHelp: admin.firestore.FieldValue.increment(1),
      });

    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.regionSubscribeCreate = functions.region('europe-west1').firestore.document('/offer-help/{helperId}')
  .onCreate(async (snap, context) => {
    try {
      const db = admin.firestore();
      await db.collection('/stats').doc('external').update({
        regionSubscribed: admin.firestore.FieldValue.increment(1),
      });
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.reportedPostsCreate = functions.region('europe-west1').firestore.document('/reported-posts/{reportRequestId}')
  .onCreate(async (snap, context) => {
    try {
      const db = admin.firestore();
      const snapValue = snap.data();
      const { askForHelpId, uid } = snapValue;

       // https://cloud.google.com/firestore/docs/manage-data/add-data#update_elements_in_an_array
      await db.collection('/ask-for-help').doc(askForHelpId).update({
        'd.reportedBy': admin.firestore.FieldValue.arrayUnion(uid)
      });
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });
