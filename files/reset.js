// reset.js
const mongoose = require("mongoose");

// Ton URI MongoDB Atlas
const MONGO_URI = "mongodb+srv://randriantsoa54_db_user:E94vuAKxp5rr6qyN@moozik.3gglcij.mongodb.net/moozik_db?retryWrites=true&w=majority";

async function resetDatabase() {
  try {
    // Connexion à MongoDB (plus besoin d'options deprecated)
    await mongoose.connect(MONGO_URI);

    console.log("Connecté à MongoDB");

    // Récupérer toutes les collections
    const collections = await mongoose.connection.db.collections();

    for (let collection of collections) {
      console.log(`Suppression de la collection : ${collection.collectionName}`);
      await collection.deleteMany({}); // vide la collection
      // ou await collection.drop(); // supprime complètement la collection
    }

    console.log("Toutes les collections ont été vidées !");
    process.exit(0);
  } catch (err) {
    console.error("Erreur :", err);
    process.exit(1);
  }
}

resetDatabase();

